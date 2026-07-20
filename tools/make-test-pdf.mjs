// ─────────────────────────────────────────────────────────────────────────
//  Writes test/fixtures/test-document.pdf — a minimal, VALID, hand-written
//  PDF (correct xref byte offsets) containing realistic memo text, so the
//  live e2e extraction has something meaty to work with.
//
//  Zero dependencies. After writing, the file is re-read and verified
//  programmatically: header, %%EOF, startxref target, and every xref entry's
//  byte offset must point at the matching "N 0 obj". Exits nonzero on any
//  mismatch.
//
//  Run:  node tools/make-test-pdf.mjs
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "test", "fixtures");
const OUT_PATH = join(OUT_DIR, "test-document.pdf");

// ── The memo text: a subject, key points, action items ─────────────────────
const LINES = [
  "MEMORANDUM - FACILITIES MODERNIZATION",
  "",
  "Subject: Building 4 HVAC Replacement - Phase 1 Kickoff",
  "Date: 16 July 2026",
  "From: Facilities Engineering Branch",
  "",
  "The Phase 1 replacement of the Building 4 HVAC plant begins on 4 August.",
  "The current chillers are 22 years old, operate at 61 percent efficiency,",
  "and no longer meet the lab's temperature stability requirement of plus or",
  "minus 0.5 degrees C. Phase 1 covers the two rooftop units serving the",
  "east wing cleanrooms; the west wing follows in Phase 2 next fiscal year.",
  "",
  "Key points:",
  "- Cleanroom operations in rooms 4E-110 through 4E-118 pause for ten",
  "  business days starting 4 August. Critical runs must finish by 1 August.",
  "- Temporary chillers will hold the vivarium and server room within spec;",
  "  both were validated during the June load test.",
  "- The crane lift on 6 August closes the east parking lot for one day.",
  "- Total Phase 1 cost is 1.84 million dollars, within the approved budget.",
  "",
  "Action items:",
  "- Lab managers: submit equipment shutdown checklists by 28 July.",
  "- J. Moreno: confirm temporary chiller fuel contract by 25 July.",
  "- Safety office: post east lot closure notices no later than 30 July.",
  "- Facilities: send daily status updates during the outage window.",
];

/** Escape the three characters PDF string literals care about. */
function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// ── Content stream: one text block, 14pt leading ────────────────────────────
const contentOps = [
  "BT",
  "/F1 11 Tf",
  "72 740 Td",
  "14 TL",
  ...LINES.flatMap((line, i) =>
    i === 0 ? [`(${esc(line)}) Tj`] : ["T*", `(${esc(line)}) Tj`]
  ),
  "ET",
].join("\n");

// ── Objects (ASCII only, so byte offsets == string offsets) ────────────────
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
    "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${Buffer.byteLength(contentOps, "ascii")} >>\nstream\n${contentOps}\nendstream`,
];

let pdf = "%PDF-1.4\n";
const offsets = [0]; // object 0 is the free-list head
for (let i = 0; i < objects.length; i++) {
  offsets.push(pdf.length); // ASCII throughout, so length == byte offset
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}

const xrefOffset = pdf.length;
const count = objects.length + 1;
pdf += `xref\n0 ${count}\n`;
pdf += "0000000000 65535 f \n"; // exactly 20 bytes per entry, incl. " \n"
for (let i = 1; i < count; i++) {
  pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_PATH, pdf, "ascii");

// ── Verify what was actually written ────────────────────────────────────────
function verify(path) {
  const buf = readFileSync(path);
  const s = buf.toString("ascii"); // ASCII-only file: offsets stay byte-true
  const problems = [];

  if (!s.startsWith("%PDF-1.4\n")) problems.push("missing %PDF header");
  if (!/%%EOF\s*$/.test(s)) problems.push("missing %%EOF trailer");

  const sx = /startxref\n(\d+)\n%%EOF/.exec(s);
  if (!sx) {
    problems.push("missing startxref");
  } else {
    const xrefAt = Number(sx[1]);
    if (s.slice(xrefAt, xrefAt + 4) !== "xref") {
      problems.push(`startxref ${xrefAt} does not point at the xref table`);
    } else {
      // Parse the subsection header and each 20-byte entry.
      const tableStart = s.indexOf("\n", s.indexOf("\n", xrefAt) + 1) + 1;
      const header = /xref\n0 (\d+)\n/.exec(s.slice(xrefAt));
      if (!header) {
        problems.push("unparseable xref subsection header");
      } else {
        const n = Number(header[1]);
        for (let i = 0; i < n; i++) {
          const entry = s.slice(tableStart + i * 20, tableStart + (i + 1) * 20);
          // 20 bytes exactly: offset(10) SP gen(5) SP type(1) EOL(2, here " \n")
          if (entry.length !== 20 || !/^\d{10} \d{5} [nf]( \n|\r\n)$/.test(entry)) {
            problems.push(`xref entry ${i} is not a valid 20-byte entry: ${JSON.stringify(entry)}`);
            continue;
          }
          if (i === 0) continue; // free-list head
          const off = Number(entry.slice(0, 10));
          const expect = `${i} 0 obj`;
          if (s.slice(off, off + expect.length) !== expect) {
            problems.push(
              `xref says object ${i} is at byte ${off}, but found ${JSON.stringify(
                s.slice(off, off + expect.length)
              )}`
            );
          }
        }
      }
    }
  }

  // The declared stream /Length must match the actual stream bytes.
  const lm = /\/Length (\d+) >>\nstream\n/.exec(s);
  if (!lm) {
    problems.push("missing content stream");
  } else {
    const start = lm.index + lm[0].length;
    const end = s.indexOf("\nendstream", start);
    if (end - start !== Number(lm[1])) {
      problems.push(`/Length says ${lm[1]} but the stream is ${end - start} bytes`);
    }
  }

  return problems;
}

const problems = verify(OUT_PATH);
if (problems.length) {
  console.error(`FAIL: ${OUT_PATH} did not verify:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`OK: wrote and verified ${OUT_PATH} (${readFileSync(OUT_PATH).length} bytes, ${LINES.length} lines of memo text)`);
