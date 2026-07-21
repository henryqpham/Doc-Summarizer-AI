// ─────────────────────────────────────────────────────────────────────────
//  Local server. Serves the UI and holds the Ask Sage credentials.
//
//  Why this exists: Ask Sage sends no Access-Control-Allow-Origin, so a browser
//  cannot call it directly. This process makes the call instead. As a bonus the
//  credentials never reach the browser.
//
//  Run:  npm start     then open http://localhost:3000
// ─────────────────────────────────────────────────────────────────────────
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, requireVars, requireUrl } from "./lib/env.mjs";

// Config may come from .env or the real environment. loadEnv distinguishes the
// failure modes (missing file / BOM / unparseable) instead of silently swallowing.
// Only two settings are actually required. The model is discovered below.
const REQUIRED = ["ASKSAGE_BASE_URL", "ASKSAGE_API_KEY"];
try {
  const source = loadEnv(REQUIRED);
  requireVars(REQUIRED, source);
  requireUrl("ASKSAGE_BASE_URL"); // catches unreplaced <placeholders> and non-URLs
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

// Dynamic import: asksage.mjs reads process.env at module scope, so it must load
// AFTER loadEnv() above. A static import would hoist and read empty values.
const { config, assertConfig, extractText, summarizeDocuments, summarizeFile, listModels } =
  await import("./lib/asksage.mjs");

try {
  assertConfig();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

// No model set? Don't make the user go run a separate tool — just go get the
// list and show it. This is the only thing that genuinely can't be guessed.
if (!config.model) {
  console.log(`\n  ASKSAGE_MODEL isn't set — fetching the models your account can use…\n`);
  try {
    const { models, raw } = await listModels();
    if (models?.length) {
      for (const m of models) console.log(`      ${m}`);
      console.log(`\n  Pick one and put it in .env:\n\n      ASKSAGE_MODEL=<one of the above>\n`);
    } else {
      console.log(`  Couldn't recognise the list format. Raw response:\n`);
      console.log(JSON.stringify(raw, null, 2));
      console.log(`\n  Paste this to Claude and it'll be parsed properly.\n`);
    }
  } catch (err) {
    console.error(`  ${err.message}\n`);
    // Only suggest the email exchange for an ACTUAL auth failure. A network
    // error is not an auth problem and pointing there sends you the wrong way.
    if (/Authentication failed/i.test(err.message) && !config.email) {
      console.error(`  Your instance appears to need the documented email + api_key exchange.
  Add your account email to .env:

      ASKSAGE_EMAIL=you@youragency.gov\n`);
    }
  }
  process.exit(1);
}

// Ask Sage's model list mixes government and commercial endpoints. The suffix is
// the only thing distinguishing them, and the commercial ones are often the
// newer/more capable — an easy and expensive mistake to make with CUI.
if (!/-gov$/.test(config.model)) {
  console.warn(`
  ⚠  "${config.model}" does not end in "-gov".

     Ask Sage lists government ("-gov") and commercial ("-com" or no suffix)
     endpoints side by side. Sending CUI to a commercial endpoint would be a
     spill. If this is deliberate, carry on — otherwise pick a "-gov" model.
`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
// 127.0.0.1 ONLY. Never 0.0.0.0 — this process holds CUI credentials, and
// binding it to the LAN would publish an unauthenticated proxy to them.
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "cache-control": "no-store", ...headers });
  res.end(body);
}

async function serveStatic(req, res) {
  const pathname = req.url.split("?")[0];
  let rel;
  try {
    rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    // Malformed percent-encoding (e.g. "/%zz"). decodeURIComponent throws a
    // URIError; letting it escape this async handler would be an unhandled
    // rejection — which kills the whole process. Answer 400 instead.
    return send(res, 400, "Bad request");
  }
  // Contain to PUBLIC — never join a raw request path.
  const path = join(PUBLIC, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!path.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
  try {
    const body = await readFile(path);
    send(res, 200, body, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
  } catch {
    send(res, 404, "Not found");
  }
}

/** Read the raw request body, refusing anything oversized before buffering it all. */
async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error(`File is larger than ${(limit / 1024 / 1024) | 0} MB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// JSON endpoints carry already-extracted text, not file bytes, so they get a
// tighter cap than uploads: 5 MB of text is ~8x maxInputChars — anything
// bigger is a mistake worth refusing before it's buffered.
const MAX_JSON_BYTES = 5 * 1024 * 1024;

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "content-type": "application/json" });
}

/** The uploaded file's raw bytes -> the filename + bytes the Ask Sage client needs. */
async function readUpload(req) {
  // The browser POSTs raw file bytes with the name in a header. This avoids a
  // multipart parser (and therefore a dependency) on this side entirely.
  const filename = req.headers["x-filename"] ? decodeURIComponent(req.headers["x-filename"]) : "document";
  const bytes = await readBody(req, config.maxUploadBytes);
  if (!bytes.length) throw new Error("That file is empty.");
  return { filename, bytes };
}

// NOTE for every handler below: deliberately no logging of filenames or
// content, in success OR failure — "nothing stored" includes this terminal.
// Error text goes back to the browser only.

/** POST /api/extract — file bytes in, extracted text out. No summarization. */
async function handleExtract(req, res) {
  try {
    const { filename, bytes } = await readUpload(req);
    const text = await extractText(bytes, filename);
    sendJson(res, 200, { text, chars: text.length, filename });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

/** POST /api/summarize-text — already-extracted text in, ONE combined summary out. */
async function handleSummarizeText(req, res) {
  try {
    const body = await readBody(req, MAX_JSON_BYTES);
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error("The request body must be JSON.");
    }
    // Validate the shape here, defensively, so a malformed caller gets a
    // precise complaint instead of a confusing failure deeper in the pipeline.
    const docs = parsed?.documents;
    if (!Array.isArray(docs) || docs.length === 0) {
      throw new Error('"documents" must be a non-empty array of { filename, text }.');
    }
    const documents = docs.map((doc, i) => {
      if (typeof doc?.text !== "string" || !doc.text.trim()) {
        throw new Error(`documents[${i}] needs a non-empty string "text".`);
      }
      const filename =
        typeof doc.filename === "string" && doc.filename.trim() ? doc.filename.trim() : "document";
      return { filename, text: doc.text };
    });

    // Optional: last week's report rides along as reference context so
    // trend/status/"key changes" judgments come from real prior-week evidence.
    let previous = null;
    if (parsed?.previous != null) {
      if (typeof parsed.previous !== "object" || typeof parsed.previous.text !== "string" || !parsed.previous.text.trim()) {
        throw new Error('"previous" (last week\'s report) needs a non-empty string "text".');
      }
      const pname =
        typeof parsed.previous.filename === "string" && parsed.previous.filename.trim()
          ? parsed.previous.filename.trim()
          : "previous report";
      previous = { filename: pname, text: parsed.previous.text };
    }

    const { summary, chars } = await summarizeDocuments(documents, previous);
    sendJson(res, 200, { summary, chars });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

/** POST /api/summarize — legacy one-shot: file bytes in, summary out. */
async function handleSummarize(req, res) {
  try {
    const { filename, bytes } = await readUpload(req);
    const { summary, chars } = await summarizeFile(bytes, filename);
    sendJson(res, 200, { summary, chars });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

/** GET /api/health — liveness + which model, for the UI banner. NO secrets. */
function handleHealth(req, res) {
  sendJson(res, 200, { ok: true, model: config.model, gov: /-gov$/.test(config.model) });
}

const server = createServer((req, res) => {
  // Route on the path only — a stray "?cachebust=1" must not 404 an API call.
  const path = req.url.split("?")[0];
  if (req.method === "POST" && path === "/api/extract") return handleExtract(req, res);
  if (req.method === "POST" && path === "/api/summarize-text") return handleSummarizeText(req, res);
  if (req.method === "POST" && path === "/api/summarize") return handleSummarize(req, res);
  if (req.method === "GET" && path === "/api/health") return handleHealth(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  // A POST that reaches here has a wrong PATH (every POST route above matches
  // exactly), so answer 404 in the contract's JSON error shape — a plain-text
  // 405 would point the caller at the method when the path is the problem.
  if (req.method === "POST") return sendJson(res, 404, { error: `No such endpoint: POST ${path}` });
  sendJson(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, HOST, () => {
  const masked = config.apiKey.slice(0, 6) + "…" + config.apiKey.slice(-4);
  const auth = config.email ? `${config.email} + key ${masked}` : `API key only (${masked})`;
  console.log(`
  Document Summarizer is running.

    Open:      http://localhost:${PORT}
    Instance:  ${config.baseUrl}
    Model:     ${config.model}
    Auth:      ${auth}

  Nothing is stored on this machine. Close this window to stop.
`);
});

// On Windows, "localhost" often resolves to the IPv6 loopback (::1) while the
// server above binds the IPv4 one (127.0.0.1) — the classic "localhost doesn't
// work but 127.0.0.1 does" trap. A second listener on ::1 makes localhost work
// for either family. Both are LOOPBACK ONLY — this process holds CUI
// credentials and must never listen on a LAN interface.
const server6 = createServer((req, res) => server.emit("request", req, res));
server6.on("error", () => {}); // no IPv6 stack / ::1 taken — IPv4 still serves
server6.listen(PORT, "::1");

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use. It may already be running — try http://localhost:${PORT}\n`);
    process.exit(1);
  }
  throw err;
});
