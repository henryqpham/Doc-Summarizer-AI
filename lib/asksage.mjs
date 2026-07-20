// ─────────────────────────────────────────────────────────────────────────
//  Ask Sage client — token exchange, file→text, and query.
//
//  This is NOT the Anthropic API. Ask Sage uses:
//    1. POST /user/get-token-with-api-key  {email, api_key}  -> access token
//    2. All other calls carry header `x-access-tokens: <token>`
//    3. POST /server/query takes a `message` STRING (not a messages array),
//       and has no `system` parameter — so the whole prompt travels as one
//       message: documents first, rules + template last (see lib/template.mjs).
//
//  Zero dependencies: Node 20.12+ has fetch/FormData/Blob built in.
// ─────────────────────────────────────────────────────────────────────────
import { buildMessage, buildMultiMessage, buildCompareMessage } from "./template.mjs";

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

// Ask Sage reuses field names for status words and payloads across endpoints
// (verified by probe, 16 Jul 2026): /server/query answers in `message` with
// `response` = "OK"; /server/file answers in `ret` with `response` = "OK".
// Picking the wrong field blindly yields a 2-character "document" that then
// gets summarized as if it were real. Never treat these words as content.
const STATUS_WORDS = new Set(["ok", "success", "succeeded", "done", "true", "200", "null", "none"]);

/**
 * Ask Sage's response schemas aren't publicly documented (docs site is an SPA,
 * SwaggerHub 404s). Try the plausible field names IN THE ORDER THE CALLER GIVES —
 * the order is endpoint-specific and load-bearing — skipping status tokens, and
 * fail with a precise diagnostic rather than returning something wrong.
 */
export function pick(data, candidates, what, { minLength = 1 } = {}) {
  for (const key of candidates) {
    // Check the top level and one level under `response`.
    for (const raw of [data?.[key], data?.response?.[key]]) {
      if (typeof raw !== "string") continue;
      const v = raw.trim();
      if (!v) continue;
      if (STATUS_WORDS.has(v.toLowerCase())) continue; // a status, not a payload
      if (v.length < minLength) continue;
      return v;
    }
  }
  // `response` itself may be the payload string.
  if (typeof data?.response === "string") {
    const v = data.response.trim();
    if (v && !STATUS_WORDS.has(v.toLowerCase()) && v.length >= minLength) return v;
  }
  throw new Error(
    `Could not find ${what} in the Ask Sage response.\n` +
      `      Top-level keys: [${Object.keys(data ?? {}).join(", ")}]\n` +
      `      Run "npm run probe" and send the raw output so this can be pinned down.`
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
      // Without a deadline, a stalled upstream leaves the UI spinning forever
      // with no way to tell "slow" from "dead". 5 minutes is generous — big
      // documents genuinely take a while to extract and summarize.
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError DOMException — that's a
    // deadline, not a connectivity problem, so don't dress it up as one.
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error("Ask Sage took too long to respond (5 minutes). Try a smaller document, or try again.");
    }
    throw new NetworkError(`Could not reach ${config.baseUrl}${path}\n\n      ${networkHint(err)}`);
  }

  let text;
  try {
    text = await res.text();
  } catch (err) {
    // The 5-minute AbortSignal governs the BODY read too: headers can arrive
    // in time while a large body is still streaming when the deadline hits,
    // so the same timeout mapping has to apply here as around fetch() above.
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error("Ask Sage took too long to respond (5 minutes). Try a smaller document, or try again.");
    }
    throw new NetworkError(`Connection lost while reading the response from ${config.baseUrl}${path}\n\n      ${networkHint(err)}`);
  }
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

/**
 * /server/file prepends one metadata line to the extracted text:
 *
 *     {"asksage_metadata": {"filename": "…"}}\n\n<the actual document text>
 *
 * Strip it — but only after verifying the first line really IS that JSON
 * object. Never blindly cut an arbitrary first line: if the check fails, the
 * line is document content and must be kept.
 */
export function stripAsksageMetadata(text) {
  if (!text.startsWith('{"asksage_metadata"')) return text;
  const nl = text.indexOf("\n");
  const firstLine = (nl === -1 ? text : text.slice(0, nl)).trim();
  try {
    const parsed = JSON.parse(firstLine);
    if (!parsed || typeof parsed !== "object" || !("asksage_metadata" in parsed)) return text;
  } catch {
    return text; // not the metadata object after all — leave the text alone
  }
  // Drop the metadata line and the blank line(s) after it. trim() also
  // normalises trailing whitespace so length checks measure real content.
  return nl === -1 ? "" : text.slice(nl + 1).trim();
}

/** POST /server/file — Ask Sage converts PDF/DOCX/TXT/images to plain text. */
export async function extractText(bytes, filename) {
  const token = await getToken();
  const form = new FormData();
  // Don't set content-type manually — fetch adds the multipart boundary.
  form.append("file", new Blob([bytes]), filename);
  const data = await callJson("/server/file", { token, form });
  // ORDER MATTERS — VERIFIED (probe, 16 Jul 2026): on this endpoint the
  // extracted text lives in `ret` (with a leading asksage_metadata line);
  // `response` is the status word "OK" and `message` doesn't exist. Checking
  // `message` first once shipped "OK" as the document. Never put it first.
  const raw = pick(data, ["ret", "response", "text", "content", "extracted_text", "result"], "the extracted text");
  // All length checks below run on the STRIPPED text. A metadata-only `ret`
  // (e.g. a scanned PDF with no OCR text) is ~55 chars of JSON — long enough
  // to fool any pre-strip guard, but it contains zero document content.
  const text = stripAsksageMetadata(raw);
  if (text.length < 20) {
    throw new Error(
      `Extraction failed for "${filename}" — Ask Sage returned only ${text.length} characters of document text ` +
        `(after removing its metadata header). If it's a scan, Ask Sage may not have OCR'd it. ` +
        `Nothing was summarized. Run "npm run probe" if this looks wrong.`
    );
  }
  return text;
}

/**
 * One combined summary for one or more already-extracted documents.
 * documents: non-empty array of { filename, text }. A single document uses the
 * classic prompt; several are labelled and summarized together as one.
 */
export async function summarizeDocuments(documents) {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error("Nothing to summarize — no documents were provided.");
  }
  for (const doc of documents) {
    if (typeof doc?.text !== "string" || !doc.text.trim()) {
      throw new Error("Every document needs non-empty text. Nothing was summarized.");
    }
    // The same hard floor as the legacy one-shot path: under 30 characters is
    // not a document (a status word or stray metadata once shipped as a real
    // summary this way). Without this here, the extract → summarize-text flow
    // would confidently summarize garbage that /api/summarize correctly refuses.
    const len = doc.text.trim().length;
    if (len < 30) {
      throw new Error(
        `"${doc.filename || "document"}" has only ${len} characters of text — that isn't a document. ` +
          `Nothing was summarized.`
      );
    }
  }
  // The limit guards the TOTAL prompt size — five medium documents can add up
  // to one oversized request just as easily as a single 500-page PDF.
  const chars = documents.reduce((n, doc) => n + doc.text.length, 0);
  if (chars > config.maxInputChars) {
    throw new Error(
      `Combined input is too long (${chars.toLocaleString()} characters across ${documents.length} ` +
        `document${documents.length === 1 ? "" : "s"}, limit ${config.maxInputChars.toLocaleString()}). ` +
        `Summarize fewer or smaller documents at a time — nothing was truncated or sent.`
    );
  }
  const message = documents.length === 1 ? buildMessage(documents[0].text) : buildMultiMessage(documents);
  return { summary: await query(message), chars };
}

/**
 * Week-over-week comparison: last week's report vs this week's.
 * Same guards as summarization — a status word or empty extraction must
 * never silently become one side of a confident "comparison".
 */
export async function compareDocuments(previous, current) {
  for (const [label, doc] of [["previous", previous], ["current", current]]) {
    if (typeof doc?.text !== "string" || !doc.text.trim()) {
      throw new Error(`The ${label} report has no text. Nothing was compared.`);
    }
    const len = doc.text.trim().length;
    if (len < 30) {
      throw new Error(
        `The ${label} report ("${doc.filename || "document"}") has only ${len} characters — ` +
          `that isn't a report. Nothing was compared.`
      );
    }
  }
  const chars = previous.text.length + current.text.length;
  if (chars > config.maxInputChars) {
    throw new Error(
      `The two reports together are too long (${chars.toLocaleString()} characters, ` +
        `limit ${config.maxInputChars.toLocaleString()}). Nothing was truncated or sent.`
    );
  }
  return { comparison: await query(buildCompareMessage(previous, current)), chars };
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
  // extractText already returns metadata-stripped text, so this floor — like
  // every other length guard — measures real document content only.
  const text = await extractText(bytes, filename);
  // Never summarize something that obviously isn't a document. Without this, a
  // parsing mistake produces a confident summary of garbage under a green
  // "Done" — which is far worse than an error.
  if (text.length < 30) {
    throw new Error(
      `Only ${text.length} characters were extracted from "${filename}" — that isn't a document.\n` +
        `Extraction likely failed (a scan with no OCR?), or the response wasn't parsed correctly. ` +
        `Nothing was summarized. Run "npm run probe" if this looks wrong.`
    );
  }
  return summarizeDocuments([{ filename, text }]);
}
