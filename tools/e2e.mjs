// ─────────────────────────────────────────────────────────────────────────
//  LIVE end-to-end check. Run manually:  npm run e2e
//
//  ⚠ Run this deliberately, never automatically — it sends its fixture
//    documents to the real Ask Sage instance the running server points at.
//
//  Assumes the local server is ALREADY running on 127.0.0.1:3000
//  (PORT env overrides). Steps:
//    1. GET  /api/health
//    2. POST the built-in sample memo (below)  → /api/extract
//    3. POST test/fixtures/test-document.pdf   → /api/extract
//       (regenerated on the fly — the repo carries no sample documents)
//    4. /api/summarize-text on extraction 2
//    5. /api/summarize-text on extraction 3
//    6. one combined /api/summarize-text with both
//    7. legacy /api/summarize with the sample memo
//
//  Prints PASS/FAIL per step with char counts and the first 200 chars of
//  each summary. Exits nonzero on any failure.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const BASE = `http://127.0.0.1:${PORT}`;

console.log(`
  ══════════════════════════════════════════════════════════════════════
  LIVE END-TO-END CHECK against ${BASE}

  ⚠  This sends two harmless fixture documents to the REAL Ask Sage
     instance the running server is configured against:
       - a built-in sample memo (embedded in this script)
       - test/fixtures/test-document.pdf (regenerated on the fly)
     Do not adapt it to send documents you would not upload yourself.

  The local server must already be running (npm start).
  ══════════════════════════════════════════════════════════════════════
`);

let failures = 0;
function pass(name, detail = "") {
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, err) {
  failures++;
  console.error(`  FAIL  ${name} — ${err?.message ?? err}`);
}
function snip(s, n = 200) {
  return String(s).replace(/\s+/g, " ").trim().slice(0, n);
}

async function api(path, opts) {
  const res = await fetch(`${BASE}${path}`, opts);
  let data;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (${res.status}): ${snip(text, 120)}`);
  }
  if (!res.ok) throw new Error(`${path} returned ${res.status}: ${data.error ?? snip(text, 120)}`);
  return data;
}

function extractDoc(bytes, filename) {
  return api("/api/extract", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-filename": encodeURIComponent(filename),
    },
    body: bytes,
  });
}

function summarizeText(documents) {
  return api("/api/summarize-text", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ documents }),
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// The repo deliberately carries no sample documents: the text sample lives
// right here, and the PDF fixture is regenerated on demand (it's gitignored).
const SAMPLE_MEMO = `MEMORANDUM — Facilities Working Group

Subject: Parking Garage B Restriping and Temporary Closures

Summary: Garage B will be restriped over two weekends to bring stall
markings and accessible-space signage up to the current standard. Levels
close in pairs so at least two-thirds of capacity stays available at all
times. Overflow parking is authorized in Lot 14 with shuttle service at
15-minute intervals.

Key points:
- Levels 1-2 close Friday 18:00 through Monday 05:00 on the first weekend;
  levels 3-4 the following weekend.
- Accessible spaces are relocated to Level 5 during each closure, with
  temporary signage posted at every elevator lobby.
- The paint requires a 12-hour cure; vehicles entering early will be towed
  at the owner's expense per the posted notice.
- Badge readers at the Level 1 entrance are offline during the first
  weekend only; use the Loop Road entrance instead.

Action items:
- Facilities (R. Alvarez) — post closure signage 72 hours in advance (due 1 Aug).
- Security (K. Osei) — reroute patrol schedule for both weekends (due 5 Aug).
- All staff — remove vehicles from affected levels before Friday 18:00.
`;

let txtBytes, pdfBytes;
try {
  txtBytes = Buffer.from(SAMPLE_MEMO, "utf8");
  const pdfPath = join(ROOT, "test", "fixtures", "test-document.pdf");
  if (!existsSync(pdfPath)) {
    console.log(`  (regenerating ${pdfPath} via tools/make-test-pdf.mjs)`);
    const gen = spawnSync(process.execPath, [join(__dirname, "make-test-pdf.mjs")], { stdio: "inherit" });
    if (gen.status !== 0) throw new Error("make-test-pdf.mjs failed");
  }
  pdfBytes = readFileSync(pdfPath);
} catch (err) {
  console.error(`  FAIL  fixtures — ${err.message}`);
  process.exit(1);
}

// 1. health
try {
  const h = await api("/api/health");
  if (!h.ok) throw new Error(`health returned ok=${h.ok}`);
  pass("GET /api/health", `model=${h.model} gov=${h.gov}`);
  if (!h.gov) console.warn(`        ⚠ model "${h.model}" is NOT a -gov model`);
} catch (err) {
  fail("GET /api/health", err);
  console.error(`\n  Is the server running? Start it with: npm start\n`);
  process.exit(1);
}

// 2. extract sample-memo.txt
let txtExtract = null;
try {
  txtExtract = await extractDoc(txtBytes, "sample-memo.txt");
  pass("extract sample-memo.txt", `${txtExtract.chars} chars extracted`);
} catch (err) {
  fail("extract sample-memo.txt", err);
}

// 3. extract test-document.pdf
let pdfExtract = null;
try {
  pdfExtract = await extractDoc(pdfBytes, "test-document.pdf");
  pass("extract test-document.pdf", `${pdfExtract.chars} chars extracted`);
} catch (err) {
  fail("extract test-document.pdf", err);
}

// 4. summarize the txt extraction
if (txtExtract) {
  try {
    const r = await summarizeText([{ filename: "sample-memo.txt", text: txtExtract.text }]);
    pass("summarize-text (txt)", `${r.chars} chars in`);
    console.log(`        summary: ${snip(r.summary)}`);
  } catch (err) {
    fail("summarize-text (txt)", err);
  }
} else {
  fail("summarize-text (txt)", "skipped — txt extraction failed");
}

// 5. summarize the pdf extraction
if (pdfExtract) {
  try {
    const r = await summarizeText([{ filename: "test-document.pdf", text: pdfExtract.text }]);
    pass("summarize-text (pdf)", `${r.chars} chars in`);
    console.log(`        summary: ${snip(r.summary)}`);
  } catch (err) {
    fail("summarize-text (pdf)", err);
  }
} else {
  fail("summarize-text (pdf)", "skipped — pdf extraction failed");
}

// 6. one combined summary of both
if (txtExtract && pdfExtract) {
  try {
    const r = await summarizeText([
      { filename: "sample-memo.txt", text: txtExtract.text },
      { filename: "test-document.pdf", text: pdfExtract.text },
    ]);
    pass("summarize-text (combined, 2 docs)", `${r.chars} chars in`);
    console.log(`        summary: ${snip(r.summary)}`);
  } catch (err) {
    fail("summarize-text (combined, 2 docs)", err);
  }
} else {
  fail("summarize-text (combined, 2 docs)", "skipped — an extraction failed");
}

// 6b. summarize WITH a prior-week report attached — exercises the
// trend/"key changes" grounding path (previous is optional in the API).
const PREV_REPORT = [
  "# Administrator Update",
  "",
  "**Week Ending:** last week (fictional fixture)",
  "",
  "**Overall Assessment:** Garage B restriping Phase 1 in progress.",
  "",
  "# Watch Items",
  "",
  "| Item | Status | Trend |",
  "| --- | --- | --- |",
  "| Paint cure schedule | 🟡 | ↔ |",
  "| Lightning mast repair | 🟡 | ↔ |",
].join("\n");
if (txtExtract) {
  try {
    const r = await api("/api/summarize-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [{ filename: "sample-memo.txt", text: txtExtract.text }],
        previous: { filename: "last-week-report.txt", text: PREV_REPORT },
      }),
    });
    pass("summarize-text (with last week's report)", `${r.chars} chars in`);
    console.log(`        summary: ${snip(r.summary)}`);
  } catch (err) {
    fail("summarize-text (with last week's report)", err);
  }
} else {
  fail("summarize-text (with last week's report)", "skipped — txt extraction failed");
}

// 7. legacy one-shot /api/summarize
try {
  const r = await api("/api/summarize", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-filename": encodeURIComponent("sample-memo.txt"),
    },
    body: txtBytes,
  });
  pass("legacy /api/summarize (txt)", `${r.chars} chars in`);
  console.log(`        summary: ${snip(r.summary)}`);
} catch (err) {
  fail("legacy /api/summarize (txt)", err);
}

console.log(
  failures
    ? `\n  ${failures} step(s) FAILED.\n`
    : `\n  All steps passed.\n`
);
process.exit(failures ? 1 : 0);
