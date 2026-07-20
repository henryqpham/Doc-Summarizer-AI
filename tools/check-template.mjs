// ─────────────────────────────────────────────────────────────────────────
//  Sanity-checks lib/instructions.txt WITHOUT printing its content, so the
//  (potentially sensitive) template never appears in a terminal, a chat, or
//  a log. Run:  npm run check-template
//
//  Catches the one failure mode that actually happens: copying the template
//  out of a chat window collapses line breaks, flattening markdown tables
//  onto single lines.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL = join(__dirname, "..", "lib", "instructions.txt");
const EXAMPLE = join(__dirname, "..", "lib", "instructions.example.txt");

const path = existsSync(REAL) ? REAL : EXAMPLE;
const usingPlaceholder = path === EXAMPLE;

let raw;
try {
  raw = readFileSync(path, "utf8");
} catch (err) {
  console.error(`  FAIL  could not read ${path}: ${err.message}`);
  process.exit(1);
}

const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n").trim();
const lines = text.split("\n");
let problems = 0;
const warn = (msg) => {
  problems++;
  console.log(`  ⚠  ${msg}`);
};

console.log(`\n  Checking: ${usingPlaceholder ? "PLACEHOLDER (lib/instructions.example.txt)" : "lib/instructions.txt"}`);
console.log(`  ${lines.length} lines, ${text.length} characters\n`);

if (usingPlaceholder) {
  warn("lib/instructions.txt does not exist yet — the app is using the generic placeholder.");
}

// 1. Must open with the exact task line the prompt layout depends on
//    ("above", because documents come first in the assembled prompt).
if (!text.startsWith("Summarize the document(s) above")) {
  warn('does not start with "Summarize the document(s) above …" — the app puts documents BEFORE these instructions, so that exact opening matters.');
}

// 2. Chat-paste damage: a markdown table flattened onto one line shows up as
//    a very long line stuffed with many pipe-delimited cells.
for (let i = 0; i < lines.length; i++) {
  const pipes = (lines[i].match(/\|/g) || []).length;
  if (pipes >= 8 && lines[i].length > 120) {
    warn(`line ${i + 1} looks like a TABLE COLLAPSED ONTO ONE LINE (${pipes} pipes, ${lines[i].length} chars) — re-copy from the source so every | row | is its own line.`);
  }
}

// 3. Structure needs some blank lines to survive; zero suggests collapse.
if (lines.length > 5 && !lines.some((l) => l.trim() === "")) {
  warn("no blank lines at all — the template's spacing probably didn't survive the copy.");
}

// 4. A golden example was part of the plan; nudge if absent.
if (!/<example>/i.test(text)) {
  warn("no <example> block found — a filled-in fictional example locks the format better than instructions alone (optional but recommended).");
}

if (problems === 0) {
  console.log("  ✓ looks structurally sound. Restart the app, then run a test document through it.\n");
} else {
  console.log(`\n  ${problems} issue(s) above. Nothing from the file was printed.\n`);
  process.exit(usingPlaceholder ? 0 : 1);
}
