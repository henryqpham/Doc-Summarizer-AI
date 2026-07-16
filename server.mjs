// ─────────────────────────────────────────────────────────────────────────
//  Local server. Serves the UI and holds the Ask Sage credentials.
//
//  Why this exists: Ask Sage sends no Access-Control-Allow-Origin, so a browser
//  cannot call it directly. This process makes the call instead. As a bonus the
//  credentials never reach the browser.
//
//  Run:  npm start     (or double-click start.bat)
// ─────────────────────────────────────────────────────────────────────────
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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
const { config, assertConfig, summarizeFile, listModels } = await import("./lib/asksage.mjs");

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
const PORT = Number(process.env.PORT || 8765);
// 127.0.0.1 ONLY. Never 0.0.0.0 — this process holds CUI credentials, and
// binding it to the LAN would publish an unauthenticated proxy to them.
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "cache-control": "no-store", ...headers });
  res.end(body);
}

async function serveStatic(req, res) {
  const pathname = req.url.split("?")[0];
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
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

async function handleSummarize(req, res) {
  try {
    // The browser POSTs raw file bytes with the name in a header. This avoids a
    // multipart parser (and therefore a dependency) on this side entirely.
    const filename = req.headers["x-filename"] ? decodeURIComponent(req.headers["x-filename"]) : "document";
    const bytes = await readBody(req, config.maxUploadBytes);
    if (!bytes.length) throw new Error("That file is empty.");

    const { summary, chars } = await summarizeFile(bytes, filename);
    send(res, 200, JSON.stringify({ summary, chars }), { "content-type": "application/json" });
  } catch (err) {
    // NOTE: deliberately no logging of filenames or content — "nothing stored"
    // includes this terminal.
    send(res, 400, JSON.stringify({ error: err.message }), { "content-type": "application/json" });
  }
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/summarize") return handleSummarize(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  send(res, 405, "Method not allowed");
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  const masked = config.apiKey.slice(0, 6) + "…" + config.apiKey.slice(-4);
  const auth = config.email ? `${config.email} + key ${masked}` : `API key only (${masked})`;
  console.log(`
  Document Summarizer is running.

    Open:      ${url}
    Instance:  ${config.baseUrl}
    Model:     ${config.model}
    Auth:      ${auth}

  Nothing is stored on this machine. Close this window to stop.
`);
  // Open the default browser so the end user never touches a terminal.
  // Skipped under `npm run dev` (--watch), which restarts on every save and
  // would otherwise spawn a new tab each time.
  const watching = process.execArgv.some((a) => a.startsWith("--watch"));
  if (watching || process.env.OPEN_BROWSER === "0") return;
  if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use. It may already be running — try ${`http://${HOST}:${PORT}`}\n`);
    process.exit(1);
  }
  throw err;
});
