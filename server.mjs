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

// Load .env if present. If it isn't, fall through — the values may already be
// set in the real environment. assertConfig() below reports what's missing.
try {
  process.loadEnvFile();
} catch {
  /* no .env — rely on process.env */
}

const { config, assertConfig, summarizeFile } = await import("./lib/asksage.mjs");

try {
  assertConfig();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
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
  console.log(`
  Document Summarizer is running.

    Open:      ${url}
    Instance:  ${config.baseUrl}
    Model:     ${config.model}
    Account:   ${config.email}  (key ${masked})

  Nothing is stored on this machine. Close this window to stop.
`);
  // Open the PM's default browser so she never touches a terminal.
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
