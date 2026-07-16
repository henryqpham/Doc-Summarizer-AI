// ─────────────────────────────────────────────────────────────────────────
//  Ask Sage client — token exchange, file→text, and query.
//
//  This is NOT the Anthropic API. Ask Sage uses:
//    1. POST /user/get-token-with-api-key  {email, api_key}  -> access token
//    2. All other calls carry header `x-access-tokens: <token>`
//    3. POST /server/query takes a `message` STRING (not a messages array),
//       and has no `system` parameter — instructions are prepended instead.
//
//  Zero dependencies: Node 20.12+ has fetch/FormData/Blob built in.
// ─────────────────────────────────────────────────────────────────────────
import { buildMessage } from "./template.mjs";

// Every value is trimmed. Windows editors save .env as CRLF by default, and a
// trailing \r silently corrupts a key (401 that looks like a wrong key) or a URL
// (malformed fetch). Trimming makes a CRLF .env just work.
export const config = {
  baseUrl: (process.env.ASKSAGE_BASE_URL || "").trim().replace(/\/+$/, ""),
  email: (process.env.ASKSAGE_EMAIL || "").trim(),
  apiKey: (process.env.ASKSAGE_API_KEY || "").trim(),
  model: (process.env.ASKSAGE_MODEL || "").trim(),

  // Deliberately loose guard (~170k tokens at a conservative 3.5 chars/token).
  // Its only job is to fail fast on a 500-page PDF instead of uploading it.
  // The API's own error is the authoritative backstop. We never truncate.
  maxInputChars: 600_000,

  // Hard cap on upload size, enforced before anything is read into memory.
  maxUploadBytes: 25 * 1024 * 1024,
};

/** Fail early and clearly rather than 401-ing later with a confusing message. */
export function assertConfig() {
  // Only the key and the host are required. `email` is optional (getToken falls
  // back to key-only auth), and `model` is optional here because startup fetches
  // the list and shows you the options if it's unset.
  const missing = ["baseUrl", "apiKey"].filter((k) => !config[k]);
  if (missing.length) {
    const names = { baseUrl: "ASKSAGE_BASE_URL", apiKey: "ASKSAGE_API_KEY" };
    throw new Error(
      `Missing in .env: ${missing.map((k) => names[k]).join(", ")}\n` +
        `  Copy .env.example to .env and fill it in.\n` +
        `  Run "npm run probe" to discover your model name.`
    );
  }
  // A regex like /^https?:\/\// is NOT enough — "https://api.<placeholder>.ai"
  // passes it and then explodes inside fetch. Parse it properly.
  try {
    new URL(config.baseUrl);
  } catch {
    throw new Error(`ASKSAGE_BASE_URL is not a valid URL: "${config.baseUrl}"`);
  }
}

/**
 * Ask Sage's response schemas aren't publicly documented (docs site is an SPA,
 * SwaggerHub 404s). Rather than guess one field name, try the plausible ones and
 * fail with a precise diagnostic naming what we actually got.
 */
export function pick(data, candidates, what) {
  for (const key of candidates) {
    const v = data?.[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    // Some Ask Sage endpoints nest the payload one level under `response`.
    const nested = data?.response?.[key];
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  if (typeof data?.response === "string" && data.response.trim()) return data.response.trim();
  throw new Error(
    `Could not find ${what} in the Ask Sage response. Top-level keys: [${Object.keys(data ?? {}).join(", ")}]. ` +
      `Run "npm run probe" and send the raw output so this can be pinned down.`
  );
}

function friendlyStatus(status, body) {
  if (status === 401) return "Authentication failed — check ASKSAGE_EMAIL / ASKSAGE_API_KEY in .env (and that it saved as LF, not CRLF).";
  if (status === 403) return "Permission denied — this account may not have access to that model or endpoint.";
  if (status === 413) return "The document is too large for Ask Sage to accept.";
  if (status === 429) return "Rate limited by Ask Sage. Wait a moment and try again.";
  if (status >= 500) return `Ask Sage returned a server error (${status}). Try again shortly.`;
  return `Ask Sage returned ${status}: ${String(body).slice(0, 300)}`;
}

/** Turn Node's opaque "fetch failed" into something actionable. */
export class NetworkError extends Error {}

function networkHint(err) {
  const code = err?.cause?.code;
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `DNS could not resolve that host.\n      Either ASKSAGE_BASE_URL is wrong, or you're not on the network that can see it (VPN?).`;
    case "ECONNREFUSED":
      return `The host refused the connection — right name, nothing listening on 443?`;
    case "UND_ERR_CONNECT_TIMEOUT":
    case "ETIMEDOUT":
      return `Connection timed out — usually a firewall, or you're off the network.`;
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return `TLS certificate not trusted (${code}) — common with an internal/proxied gov endpoint.`;
    default:
      return err?.cause?.message || err.message;
  }
}

async function callJson(path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers["x-access-tokens"] = token;
  if (!form) headers["content-type"] = "application/json";

  let res;
  try {
    res = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: form ?? JSON.stringify(body),
    });
  } catch (err) {
    throw new NetworkError(`Could not reach ${config.baseUrl}${path}\n\n      ${networkHint(err)}`);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(friendlyStatus(res.status, text));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Ask Sage returned non-JSON from ${path}: ${text.slice(0, 200)}`);
  }
}

// Token is cached in memory only, and re-fetched on demand. Never written to disk.
let cachedToken = null;

export async function getToken({ force = false } = {}) {
  // Key-only mode: no email configured, so treat the API key as the token.
  // If the instance rejects that, the caller gets a clear 401 telling them to
  // add ASKSAGE_EMAIL. Run `npm run probe` to confirm which mode applies.
  if (!config.email) return config.apiKey;

  if (cachedToken && !force) return cachedToken;
  const data = await callJson("/user/get-token-with-api-key", {
    body: { email: config.email, api_key: config.apiKey },
  });
  cachedToken = pick(data, ["access_token", "token", "accessToken", "x-access-tokens"], "an access token");
  return cachedToken;
}

/**
 * POST /server/get-models — the list of models this account can use.
 * Returns a string[] if the shape is recognisable, else the raw payload so the
 * caller can print something useful rather than nothing.
 */
export async function listModels() {
  const token = await getToken();
  const data = await callJson("/server/get-models", { token, body: {} });
  const arr = [data, data?.response, data?.models, data?.message].find((v) => Array.isArray(v));
  if (!arr) return { raw: data };
  // Entries may be plain strings or objects with a name/id field.
  return { models: arr.map((m) => (typeof m === "string" ? m : m?.name ?? m?.id ?? m?.model ?? JSON.stringify(m))) };
}

/** POST /server/file — Ask Sage converts PDF/DOCX/TXT/images to plain text. */
export async function extractText(bytes, filename) {
  const token = await getToken();
  const form = new FormData();
  // Don't set content-type manually — fetch adds the multipart boundary.
  form.append("file", new Blob([bytes]), filename);
  const data = await callJson("/server/file", { token, form });
  return pick(data, ["message", "response", "text", "content", "result"], "the extracted text");
}

/** POST /server/query — the main completion endpoint. */
export async function query(message) {
  const token = await getToken();
  const data = await callJson("/server/query", {
    token,
    body: {
      message,
      model: config.model,
      // Low temperature: we want the fixed template followed, not creativity.
      temperature: 0.0,
      // "none" — do NOT attach org datasets. Avoids RAG and any ingestion path.
      dataset: "none",
      // 0 — do NOT let the request reach live/internet sources. CUI must not
      //     leave the platform. (Their sample uses live:1; we deliberately don't.)
      live: 0,
      limit_references: 0,
    },
  });
  return pick(data, ["message", "response", "answer", "content", "result", "text"], "the model's answer");
}

/** Full pipeline: file bytes -> extracted text -> formatted summary. */
export async function summarizeFile(bytes, filename) {
  const text = await extractText(bytes, filename);
  if (!text) {
    throw new Error("No text could be extracted from that file. If it's a scan, Ask Sage may not have OCR'd it.");
  }
  if (text.length > config.maxInputChars) {
    throw new Error(
      `Document is too long (${text.length.toLocaleString()} characters, limit ${config.maxInputChars.toLocaleString()}). ` +
        `Split it and summarize the parts separately — nothing was truncated or sent.`
    );
  }
  return { summary: await query(buildMessage(text)), chars: text.length };
}
