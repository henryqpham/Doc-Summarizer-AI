// ─────────────────────────────────────────────────────────────────────────
//  BUILD — inline styles, the bundled libraries, and all app code into a
//  single self-contained file: dist/summarizer.html (the thing you email).
//
//  Run with:  npm run build
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "src");
const nm = join(root, "node_modules");
const distDir = join(root, "dist");

const read = (p) => readFileSync(p, "utf8");

// Inside a <script> block the HTML parser stops at the first "</script",
// regardless of JS context. Escaping it keeps inlined library code intact.
const escScript = (s) => s.replaceAll("</script", "<\\/script");

// ── inputs ──────────────────────────────────────────────────────────────
const template = read(join(src, "index.html"));
const css = read(join(src, "styles.css"));

// Bundled libraries (installed via `npm install`).
const mammoth = read(join(nm, "mammoth", "mammoth.browser.min.js"));
const pdf = read(join(nm, "pdfjs-dist", "build", "pdf.min.js"));
const pdfWorker = read(join(nm, "pdfjs-dist", "build", "pdf.worker.min.js"));

// App source, concatenated in load order.
const appFiles = ["config.js", "template.js", "extract.js", "api.js", "app.js"];
const app = appFiles
  .map((f) => `// ── ${f} ──\n${read(join(src, f))}`)
  .join("\n\n");

// ── assemble ────────────────────────────────────────────────────────────
const vendor = [
  `<script>${escScript(mammoth)}</script>`,
  `<script>${escScript(pdf)}</script>`,
  // Non-executing tag; extract.js reads its text and makes a Blob-URL worker.
  `<script id="pdf-worker" type="javascript/worker">${escScript(pdfWorker)}</script>`,
].join("\n");

const html = template
  .replace("/* BUILD:STYLES */", () => css)
  .replace("<!-- BUILD:VENDOR -->", () => vendor)
  .replace("<!-- BUILD:APP -->", () => `<script>\n${escScript(app)}\n</script>`);

// ── write ───────────────────────────────────────────────────────────────
mkdirSync(distDir, { recursive: true });
const out = join(distDir, "summarizer.html");
writeFileSync(out, html, "utf8");
console.log(`Built ${out}  (${(html.length / 1024).toFixed(0)} KB)`);
