// ─────────────────────────────────────────────────────────────────────────
//  Week-over-week reconciliation. Built 23 Jul 2026 after a live failure:
//  with last week's FINAL report riding along as raw markdown, the model
//  copied whole stale sections into this week's report, showed old and new
//  values for the same item side by side, and restated last week's news as
//  current. Research verdict (5-sweep pass, 23 Jul): a prior report in the
//  exact output format is the strongest possible distractor — models copy
//  from context at measured 20-70% rates and no instruction wording
//  reliably stops it. The fix is architectural:
//
//    1. The model NEVER sees last week's report as a report. Code reduces
//       it to a plain numbered fact list (headings folded in, tables
//       flattened, status emoji spelled out) that shares no formatting
//       with the output structure.
//    2. Code — not the model — matches items across the two weeks by name
//       anchors and detects value changes by number anchors, computing
//       old → new plus magnitude ("5 days later", "up 3"). Only these
//       code-computed changes may be written as was/now comparisons.
//    3. After generation, code audits the report: a number that exists
//       ONLY in last week's report and appears outside a "(was …)"
//       comparison is a stale leak. One bounded repair round (REPLACE/
//       DELETE blocks, code-verified) fixes what it can; the rest is
//       reported honestly in stats.
//
//  Dropping is deliberate, never silent: prior-week content absent from
//  this week's report surfaces in the browser's left-out panel (verify.js)
//  for a human decision. The whole pass fails OPEN like ensureCompleteness:
//  any error returns the untouched report.
// ─────────────────────────────────────────────────────────────────────────
import { makeFact, makeReportIndex, isCovered, numAnchors, normNum, NUM_RE } from "./ledger.mjs";
import { preprocessDocText } from "./preprocess.mjs";

// ── flattening last week's report into neutral facts ────────────────────
// Status symbols carry real state — spell them out instead of dropping
// them, then strip whatever emoji remain so no output formatting survives.
const EMOJI_WORDS = [
  [/🟢/g, "(status green)"],
  [/🟡/g, "(status yellow)"],
  [/🔴/g, "(status red)"],
  [/⚠️?/g, "(warning)"],
  [/↔/g, "(trend steady)"],
  [/↑/g, "(trend up)"],
  [/↓/g, "(trend down)"],
];
const OTHER_EMOJI = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{FE0F}]/gu;

function neutralize(line) {
  let s = line;
  for (const [re, word] of EMOJI_WORDS) s = s.replace(re, word);
  return s.replace(OTHER_EMOJI, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Last week's report text -> [{ section, text, fact }] with all markdown
 * structure dissolved. Table rows become "first cell: rest, of, cells";
 * headings become the section label of what follows, never a line of
 * their own.
 */
export function flattenPriorReport(text) {
  const out = [];
  let section = "";
  const rawLines = String(text).split(/\r?\n/);
  const isSeparator = (s) => /^\|?[\s:|-]+\|[\s:|-]*$/.test(String(s || "").trim());
  for (let li = 0; li < rawLines.length; li++) {
    const line = rawLines[li].trim();
    if (!line) continue;
    const heading = line.match(/^#{1,4}\s+(.*)$/) || line.match(/^\*\*(.+?)\*\*:?\s*$/);
    if (heading) {
      section = neutralize(heading[1]);
      continue;
    }
    if (isSeparator(line)) continue; // table separator row
    if (isSeparator(rawLines[li + 1])) continue; // header row ("Item | Date") — labels, not facts
    let plain;
    if (line.includes("|")) {
      const cells = line.split("|").map((c) => neutralize(c)).filter(Boolean);
      if (!cells.length) continue;
      plain = cells.length > 1 ? cells[0] + ": " + cells.slice(1).join(", ") : cells[0];
    } else {
      plain = neutralize(line.replace(/^[-*•]\s+/, ""));
    }
    if (plain.length < 15) continue; // fragments carry no checkable fact
    out.push({ section, text: plain, fact: makeFact(plain) });
  }
  return out;
}

/** The numbered plain list that goes in the prompt in place of the report. */
export function renderPriorLedger(items) {
  return items
    .map((it, i) => `${i + 1}. ${it.section ? "(" + it.section + ") " : ""}${it.text}`)
    .join("\n");
}

// ── cross-week matching and computed deltas ─────────────────────────────
// Typed number tokens so old/new pair only within a type: a date never
// "changes into" a dollar figure.
function tokenType(tok) {
  if (tok.includes("/")) return "date";
  if (tok.includes("$")) return "money";
  if (tok.includes("%")) return "pct";
  return "num";
}

function parseDate(tok) {
  const m = tok.match(/^(\d+)\/(\d+)(?:\/(\d+))?$/);
  if (!m) return null;
  let year = m[3] ? Number(m[3]) : new Date().getFullYear();
  if (year < 100) year += 2000;
  const d = new Date(year, Number(m[1]) - 1, Number(m[2]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "5 days later" / "up 3" / "" — factual direction+magnitude only. The
 *  model turns it into the report's judgment words (slipped/improved),
 *  because whether "later" is bad depends on what the item is. */
export function deltaWording(oldTok, newTok) {
  const type = tokenType(oldTok);
  if (type !== tokenType(newTok)) return "";
  if (type === "date") {
    const a = parseDate(oldTok);
    const b = parseDate(newTok);
    if (!a || !b) return "";
    const days = Math.round((b - a) / 86400000);
    if (!days) return "";
    return Math.abs(days) + (Math.abs(days) === 1 ? " day " : " days ") + (days > 0 ? "later" : "earlier");
  }
  const num = (t) => Number(normNum(t).replace(/[$%kmb]/g, ""));
  const a = num(oldTok);
  const b = num(newTok);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return "";
  const diff = Math.round((b - a) * 100) / 100;
  return (diff > 0 ? "up " : "down ") + Math.abs(diff) + (type === "pct" ? " points" : "");
}

/** Stem-tolerant containment, same rule as ledger.mjs nameHit. */
function textHasName(lower, n) {
  return lower.includes(n) || lower.includes(n.slice(0, Math.max(4, n.length - 3)));
}

// Identity tokens for cross-week matching: the capitalized-name anchors
// PLUS every ≥5-char word of the item's text. Table labels like "CM
// completion" carry no capitalized name, so names alone miss them (found
// on the first synthetic test). Neutralization artifacts and ultra-generic
// report words are excluded; the exactly-one-candidate rule below is the
// real guard against a generic token matching everywhere.
const TOKEN_STOP = new Set([
  "status", "yellow", "green", "warning", "trend", "steady",
  "week", "weeks", "weekly", "report", "since", "level", "there", "their",
]);
function identityTokens(fact, text) {
  const tokens = new Set(fact.names);
  for (const w of String(text).toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) || []) {
    if (!TOKEN_STOP.has(w)) tokens.add(w);
  }
  return [...tokens];
}

/**
 * Match last week's items against this week's document text. Returns only
 * changes where BOTH values are pinned by code — an authoritative was/now
 * list. Items covered as-is count as carried; items whose identity tokens
 * never appear this week are prior-only (the left-out panel's business,
 * and deliberately NOT the prompt's: listing them would re-import copy
 * bait).
 */
export function computeChanges(priorItems, currentText) {
  const idx = makeReportIndex(currentText);
  const lines = String(currentText).split(/\r?\n/);
  const changes = [];
  let carried = 0;
  let priorOnly = 0;

  for (const it of priorItems) {
    const fact = it.fact;
    if (isCovered(idx, fact)) {
      carried++;
      continue;
    }
    const tokens = identityTokens(fact, it.text).filter((t) => textHasName(idx.lower, t));
    if (!tokens.length || !fact.nums.length) {
      priorOnly++;
      continue;
    }
    // The item's identity exists this week but a number differs — find the
    // new value. Candidate lines are those carrying one of the matched
    // tokens; a change is only claimed when exactly ONE same-typed distinct
    // value appears across them (ambiguity means silence, never a guess).
    const missing = fact.nums.filter((n) => !idx.numSet.has(n));
    for (const oldNorm of missing) {
      const oldRaw = (it.text.match(NUM_RE) || []).find((t) => normNum(t) === oldNorm) || oldNorm;
      const type = tokenType(oldNorm);
      const candidates = new Set();
      for (const line of lines) {
        const lower = line.toLowerCase();
        if (!tokens.some((t) => textHasName(lower, t))) continue;
        for (const tok of line.match(NUM_RE) || []) {
          if (tokenType(tok) === type && normNum(tok) !== oldNorm) candidates.add(normNum(tok) + " " + tok);
        }
      }
      const distinct = new Set([...candidates].map((c) => c.split(" ")[0]));
      if (distinct.size !== 1) continue;
      const newRaw = [...candidates][0].split(" ")[1];
      changes.push({ item: it.text, section: it.section, old: oldRaw, new: newRaw, delta: deltaWording(oldRaw, newRaw) });
    }
  }
  return { changes, carried, priorOnly };
}

/** The computed-changes block for the prompt. Explicit "none" beats an
 *  absent block: it denies the model room to invent a comparison. */
export function renderChanges(changes) {
  if (!changes.length) return "No value changes were detected mechanically this week.";
  return changes
    .map((c, i) => `${i + 1}. ${c.item} -> now ${c.new} (was ${c.old}${c.delta ? ", " + c.delta : ""})`)
    .join("\n");
}

// ── the staleness audit ─────────────────────────────────────────────────
/**
 * Numbers in the report that exist ONLY in last week's facts (not in this
 * week's documents) are stale leaks — unless the line frames them as an
 * explicit comparison ("(was …)"). The report's first lines are exempt:
 * the week-ending date is injected by dateRule, not by any document.
 */
export function auditStaleness(report, priorItems, currentText) {
  const currentNums = new Set(numAnchors(preprocessAll(currentText)));
  const priorNums = new Set();
  for (const it of priorItems) for (const n of it.fact.nums) priorNums.add(n);

  const leaks = [];
  const lines = String(report).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i < 3) continue; // "Notes for the week ending …" carries an injected date
    const line = lines[i];
    if (/\(was\b/i.test(line)) continue; // explicit comparison — old values belong here
    // The sanctioned quiet-section line cites last week's date by design.
    if (/no significant updates this week.*last reported/i.test(line)) continue;
    const stale = numAnchors(line).filter((n) => priorNums.has(n) && !currentNums.has(n));
    if (stale.length) leaks.push({ line: line.trim(), nums: stale });
  }
  return leaks;
}

function preprocessAll(currentText) {
  return currentText; // already preprocessed by the caller; kept for clarity
}

// ── bounded repair: REPLACE/DELETE blocks, code-verified ────────────────
export function buildRepairMessage(report, leaks) {
  const list = leaks
    .map((l, i) => `${i + 1}. ${l.line}\n   (stale value${l.nums.length > 1 ? "s" : ""}: ${l.nums.join(", ")})`)
    .join("\n");
  return [
    "The report below contains lines carrying values that come from LAST",
    "week's report and are not stated in this week's documents. For EACH",
    "numbered line output exactly one block, nothing else.",
    "",
    "If the line is wrong without the stale value, or the whole line is",
    "last week's information:",
    "FOR <number>: DELETE",
    "FIND: <copy the line exactly as listed>",
    "",
    "If the line is right but the stale value must go or become an explicit",
    "comparison:",
    "FOR <number>: REPLACE",
    "FIND: <copy the line exactly as listed>",
    "LINE: <the corrected line. Keep this week's values verbatim. A last-",
    'week value may appear ONLY inside "(was <value>)". Never use an em',
    "dash.>",
    "",
    "Never touch any other line. Never add new facts.",
    "",
    "LINES:",
    list,
    "",
    "<report>",
    report,
    "</report>",
  ].join("\n");
}

/**
 * Apply REPLACE/DELETE blocks. Every edit is verified: FIND must locate a
 * real line, and a REPLACE line may only carry numbers from this week's
 * documents (or a stale number inside a "(was …)" frame). Unverifiable
 * edits are skipped — the leak stays on the books and is reported.
 */
export function applyEditPatches(report, patchText, leaks, currentNums) {
  const marks = [];
  const re = /^FOR\s+(\d+)\s*:\s*(REPLACE|DELETE)\s*$/gim;
  let m;
  while ((m = re.exec(patchText)) !== null) {
    marks.push({ idx: Number(m[1]), kind: m[2].toUpperCase(), end: re.lastIndex, start: m.index });
  }
  const blocks = marks.map((mk, i) => ({
    ...mk,
    body: patchText.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : undefined),
  }));
  const field = (body, name) => {
    const mm = body.match(new RegExp("^" + name + ":\\s*(.+)$", "mi"));
    return mm ? mm[1].trim() : null;
  };

  let lines = report.split("\n");
  const norm = (s) => String(s).trim();
  let fixed = 0;
  const handled = new Set();

  for (const b of blocks) {
    const leak = leaks[b.idx - 1];
    if (!leak || handled.has(b.idx)) continue;
    const find = field(b.body, "FIND");
    if (!find) continue;
    const probe = norm(find).slice(0, 60);
    if (probe.length < 10) continue;
    const pos = lines.findIndex((l) => norm(l).includes(probe));
    // The edit must land on the leaking line, not a lookalike elsewhere.
    if (pos === -1 || !norm(lines[pos]).includes(norm(leak.line).slice(0, 40))) continue;

    if (b.kind === "DELETE") {
      lines.splice(pos, 1);
      handled.add(b.idx);
      fixed++;
      continue;
    }
    let line = field(b.body, "LINE");
    if (!line) continue;
    line = line.replace(/\s*—\s*/g, ", "); // voice rule: no em dashes, ever
    const hasWas = /\(was\b/i.test(line);
    const ok = numAnchors(line).every((n) => currentNums.has(n) || (hasWas && leak.nums.includes(n)));
    if (!ok) continue; // a repair may never smuggle in new numbers
    lines[pos] = line;
    handled.add(b.idx);
    fixed++;
  }
  return { report: lines.join("\n"), fixed };
}

// ── the pipeline ────────────────────────────────────────────────────────
/** Same transient-blip retry as ensureCompleteness (502/503 seen live). */
async function tryQuery(query, msg) {
  try {
    return await query(msg);
  } catch (err) {
    if (/5\d\d|try again|too long/i.test(String(err && err.message))) {
      await new Promise((r) => setTimeout(r, 15_000));
      return await query(msg);
    }
    throw err;
  }
}

/**
 * Post-generation audit + one bounded repair round. query is injected like
 * ensureCompleteness's. Fails open — callers wrap it, and any error path
 * returns the untouched report with the error in stats.
 */
export async function reconcileAudit(query, documents, previous, report) {
  const priorItems = flattenPriorReport(previous.text);
  const currentText = documents.map((d) => preprocessDocText(d.text)).join("\n");
  const stats = { priorFacts: priorItems.length, staleLeaks: 0, staleFixed: 0, staleResidual: [] };
  if (!priorItems.length) return { report, stats };

  let leaks = auditStaleness(report, priorItems, currentText);
  stats.staleLeaks = leaks.length;
  if (!leaks.length) return { report, stats };

  const currentNums = new Set(numAnchors(currentText));
  const patchText = await tryQuery(query, buildRepairMessage(report, leaks));
  const r = applyEditPatches(report, patchText, leaks, currentNums);
  stats.staleFixed = r.fixed;

  const residual = auditStaleness(r.report, priorItems, currentText);
  stats.staleResidual = residual.map((l) => l.line);
  return { report: r.report, stats };
}

/**
 * The prompt-side prior sections: the neutral facts list plus the
 * computed-changes block. Replaces shipping last week's raw markdown —
 * the report form of the reference never enters the context again.
 */
export function buildPriorSections(previous, documents, suf) {
  const priorItems = flattenPriorReport(previous.text);
  const currentText = documents.map((d) => preprocessDocText(d.text)).join("\n");
  const { changes } = computeChanges(priorItems, currentText);
  const src = String(previous.filename || "previous report").replace(/"/g, "'");
  // The prior report's own week-ending date, extracted in code so the
  // "last reported <date>" placeholder line never guesses it.
  const asOf = String(previous.text).match(/week ending\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  return [
    "Before this week's documents, here is what LAST WEEK'S REPORT" +
      (asOf ? ` (week ending ${asOf[1]})` : "") + " said,",
    "reduced by the tool to a plain list of facts. Every line is at least",
    "one week old. Nothing in it may be treated as current:",
    "",
    `<last_week_facts_${suf} source="${src}">`,
    renderPriorLedger(priorItems),
    `</last_week_facts_${suf}>`,
    "",
    "The tool also compared last week's facts against this week's documents",
    "mechanically. These are the only AUTHORITATIVE week-over-week value",
    "changes:",
    "",
    `<computed_changes_${suf}>`,
    renderChanges(changes),
    `</computed_changes_${suf}>`,
    "",
  ];
}
