// ─────────────────────────────────────────────────────────────────────────
//  Completeness pipeline: fact ledger -> coverage contract -> additive
//  patches. Built 23 Jul 2026.
//
//  WHY: hosted LLM inference is nondeterministic even at temperature 0
//  (batched inference changes float reduction order), and long prose
//  under length pressure triages facts. Measured on 3 byte-identical
//  runs: only 69% of sentinel facts were stable; each run dropped a
//  different ~15%; the union held 97%. Research verdict (23 Jul, three
//  literature sweeps): never merge or re-generate whole drafts (the
//  merge pass is itself a lossy generation and silently compresses past
//  ~2K words of output); instead:
//
//    1. Extract atomic number/date-bearing facts from the SOURCE docs.
//       Extraction outputs are short, so run-to-run variance is small;
//       two samples are unioned IN CODE (deterministic).
//    2. Check every ledger fact against the draft IN CODE (numbers and
//       dates exact-match; names as a guard). External deterministic
//       detection is the only correction signal that works.
//    3. Ask the model for PATCH BLOCKS ONLY (fact -> section, anchor
//       line, new line). Code splices them in. The model never re-emits
//       the report, so already-correct content cannot be lost or
//       distorted. Unverifiable patches are rejected, not trusted.
//
//  Facts still missing after two rounds are returned to the caller
//  (surfaced, never silently dropped). The whole pass fails OPEN: any
//  error returns the untouched base draft.
// ─────────────────────────────────────────────────────────────────────────
import { preprocessDocText } from "./preprocess.mjs";

// ── anchor tokenization ──────────────────────────────────────────────────
// Dates first so "3/25/27" is not eaten digit-by-digit; then money/
// percent/decimal/plain numbers ("$1.8M", "19%", "402.15", "1,150").
export const NUM_RE = /\d+\/\d+(?:\/\d+)?|\$\d[\d,]*(?:\.\d+)?\s?[KMB]?|\d[\d,]*(?:\.\d+)?%|\d[\d,]*\.\d+|\d[\d,]*/g;
const NAME_RE = /\b[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\b/g;
const NAME_STOP = new Set([
  "The", "This", "That", "These", "Those", "With", "From", "Will", "Team", "Teams",
  "Mission", "Week", "Weeks", "Weekly", "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "January", "February", "March", "April", "June", "July", "August",
  "September", "October", "November", "December", "System", "Systems", "Program",
  "Module", "Control", "Board", "Review", "Test", "Testing", "Launch", "Complete",
  "Completed", "Status", "Risk", "Opportunity", "Watch", "Items", "Schedule",
]);

export function normNum(t) {
  return t.toLowerCase().replace(/,/g, "").replace(/\s+/g, "");
}

/** A number token is a usable anchor when it is specific enough to search
 *  for: two or more digits, or it carries /, $, % or a decimal point.
 *  Exported (with normNum and NUM_RE) for lib/reconcile.mjs, which matches
 *  the same anchors across weeks instead of within one. */
export function numAnchors(text) {
  const out = new Set();
  for (const t of String(text).match(NUM_RE) || []) {
    const digits = (t.match(/\d/g) || []).length;
    if (digits >= 2 || /[/$%.]/.test(t)) out.add(normNum(t));
  }
  return [...out];
}

function nameAnchors(text) {
  const out = new Set();
  for (const t of String(text).match(NAME_RE) || []) {
    if (t.length >= 4 && !NAME_STOP.has(t)) out.add(t.toLowerCase());
  }
  return [...out];
}

/** Number+unit phrases: a bare "3" is too weak to search for, but
 *  "3 weeks" is a checkable anchor. Hyphens fold to spaces on both sides
 *  so "3-week" still matches. */
const PHRASE_RE = /\d+\s?-?\s?(days?|weeks?|months?|hours?|shifts?|sequences?)\b/gi;
function phraseAnchors(text) {
  const out = new Set();
  for (const t of String(text).match(PHRASE_RE) || []) {
    out.add(t.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").replace(/s$/, "").trim());
  }
  return [...out];
}

export function makeFact(text, keys) {
  return {
    text: text.trim(),
    nums: numAnchors(text),
    names: nameAnchors(text),
    phrases: phraseAnchors(text),
    keys: (keys || "").toLowerCase().split(/\s+/).filter((w) => w.length >= 4).slice(0, 4),
  };
}

// ── extraction ───────────────────────────────────────────────────────────
export function buildExtractionMessage(documents) {
  const sections = documents.map((d, i) =>
    [
      `<document index="${i + 1}" source="${String(d.filename).replace(/"/g, "'")}">`,
      preprocessDocText(d.text),
      "</document>",
    ].join("\n")
  );
  return [
    "You are building a fact checklist, not a summary. From the documents",
    "below, list EVERY stated fact that carries a number, date, dollar",
    "amount, percentage, headcount, duration, version, or a named risk,",
    "opportunity, decision, milestone, or anomaly.",
    "",
    "Rules:",
    "- One fact per line, in exactly this format:",
    "  FACT: <one short sentence> | KEY: <the 2 or 3 most distinctive words of that fact>",
    "- Keep every number, date, and name from the document verbatim.",
    "- Only what the documents state. No interpretation, no rollups.",
    "- Do not skip small facts. Cover every document, start to finish.",
    "- If two documents state the same fact, list it once.",
    "- Output nothing except FACT: lines.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

export function parseFacts(modelText) {
  const out = [];
  for (const m of String(modelText).matchAll(/^FACT:\s*(.+)$/gm)) {
    let t = m[1].trim();
    let keys = "";
    const bar = t.match(/^(.*?)\s*\|\s*KEY:\s*(.+)$/);
    if (bar) {
      t = bar[1].trim();
      keys = bar[2].trim();
    }
    if (t.length > 8) out.push(makeFact(t, keys));
  }
  return out;
}

/** Deterministic union of N extraction samples. Two facts are duplicates
 *  when their number-anchor signatures match AND either their texts are
 *  identical/one contains the other (catches facts with no usable name
 *  anchor — "Pad crane load test window compressed by 6 days…" was listed
 *  twice in a live run, 23 Jul 2026) or they share a name (numberless
 *  facts: most of their names overlap). Longest text wins. */
export function unionFacts(lists) {
  const out = [];
  const normText = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
  for (const fact of lists.flat()) {
    const ft = normText(fact.text);
    const dup = out.find((f) => {
      const sameNums =
        f.nums.length && fact.nums.length
          ? f.nums.slice().sort().join("|") === fact.nums.slice().sort().join("|")
          : f.nums.length === 0 && fact.nums.length === 0;
      if (!sameNums) return false;
      const ot = normText(f.text);
      if (ot === ft || ot.includes(ft) || ft.includes(ot)) return true;
      const shared = fact.names.filter((n) => f.names.includes(n)).length;
      const denom = Math.max(1, Math.min(f.names.length, fact.names.length));
      return fact.nums.length ? shared >= 1 : shared / denom >= 0.6;
    });
    if (!dup) out.push(fact);
    else if (fact.text.length > dup.text.length) dup.text = fact.text;
  }
  return out;
}

// ── coverage contract (pure code, no model) ─────────────────────────────
export function makeReportIndex(report) {
  const numSet = new Set();
  for (const t of String(report).match(NUM_RE) || []) numSet.add(normNum(t));
  return { numSet, lower: String(report).toLowerCase() };
}

/** Stem-tolerant name lookup: "integrated" matches "integration". */
function nameHit(index, n) {
  return index.lower.includes(n) || index.lower.includes(n.slice(0, Math.max(4, n.length - 3)));
}

export function isCovered(index, fact) {
  const foldedLower = index.lower.replace(/-/g, " ");
  const phrasesOk = (fact.phrases || []).every((p) => foldedLower.includes(p));
  if (fact.nums.length) {
    const numsOk = fact.nums.every((n) => index.numSet.has(n));
    if (!numsOk || !phrasesOk) return false;
    // A full date or a 4+ digit figure is near-unique on its own. Money,
    // percentages, and small plain numbers can collide across subjects,
    // so they additionally need one of the fact's names in the report.
    const strong = fact.nums.some(
      (n) => /\/.+\//.test(n) || (n.match(/\d/g) || []).length >= 4
    );
    if (strong || !fact.names.length) return true;
    return fact.names.some((n) => nameHit(index, n));
  }
  if (!phrasesOk) return false;
  // Numberless facts: the extractor's own KEY words are the anchors; all
  // of them (stem-tolerant) must appear. Without keys, fall back to the
  // name-majority rule; with under 2 usable names, pass rather than nag.
  if (fact.keys && fact.keys.length >= 2) {
    return fact.keys.every((k) => nameHit(index, k));
  }
  if (fact.names.length < 2) return true; // too vague to check honestly
  const present = fact.names.filter((n) => nameHit(index, n)).length;
  return present / fact.names.length >= 0.6;
}

// ── patching ─────────────────────────────────────────────────────────────
export function buildPatchMessage(documents, report, missing) {
  const sections = documents.map((d, i) =>
    [
      `<document index="${i + 1}" source="${String(d.filename).replace(/"/g, "'")}">`,
      preprocessDocText(d.text),
      "</document>",
    ].join("\n")
  );
  const list = missing.map((f, i) => `${i + 1}. ${f.text}`).join("\n");
  return [
    "The report below was generated from the documents below. The numbered",
    "facts listed were stated in the documents but could not be found in",
    "the report. For EACH numbered fact output exactly one block, nothing",
    "else.",
    "",
    "If the fact is genuinely absent from the report:",
    "FOR <number>: INSERT",
    "SECTION: <copy the exact heading line it belongs under>",
    "AFTER: <copy exactly one existing line from the report that the new",
    "line should directly follow>",
    "LINE: <the new line, in the report's existing voice and format for",
    "that section (a \"- \" bullet where the section uses bullets), keeping",
    "the documents' numbers and names verbatim. Short declarative",
    "sentences. Never use an em dash.>",
    "",
    "If the report already states the fact in different words:",
    "FOR <number>: SKIP",
    "QUOTE: <copy the exact line from the report that covers it>",
    "",
    "Never rewrite or repeat any other part of the report. Never invent",
    "content beyond the listed facts.",
    "",
    "FACTS:",
    list,
    "",
    "<report>",
    report,
    "</report>",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

export function applyPatches(report, patchText, missing) {
  const marks = [];
  const re = /^FOR\s+(\d+)\s*:\s*(INSERT|SKIP)\s*$/gim;
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
  let inserted = 0;
  let paraphrased = 0;
  const residual = [];
  const handled = new Set();

  for (const b of blocks) {
    const fact = missing[b.idx - 1];
    if (!fact || handled.has(b.idx)) continue;
    handled.add(b.idx);

    if (b.kind === "SKIP") {
      // The paraphrase claim must be verifiable: the quoted line has to
      // actually exist in the report, or the fact stays on the books.
      const quote = field(b.body, "QUOTE");
      const probe = quote ? norm(quote).slice(0, 60) : "";
      if (probe.length >= 15 && lines.join("\n").includes(probe)) paraphrased++;
      else residual.push(fact);
      continue;
    }

    let line = field(b.body, "LINE");
    if (!line) {
      residual.push(fact);
      continue;
    }
    line = line.replace(/\s*—\s*/g, ", "); // voice rule: no em dashes, ever
    // The inserted line must carry the fact's own anchors, or it is not
    // the fact we asked for.
    if (fact.nums.length && !fact.nums.some((n) => makeReportIndex(line).numSet.has(n))) {
      residual.push(fact);
      continue;
    }

    const after = field(b.body, "AFTER");
    const section = field(b.body, "SECTION");
    let pos = -1;
    if (after) {
      pos = lines.findIndex((l) => norm(l) === norm(after));
      if (pos === -1 && norm(after).length >= 12) {
        const probe = norm(after).slice(0, 40);
        pos = lines.findIndex((l) => norm(l).includes(probe));
      }
    }
    if (pos === -1 && section) {
      const target = norm(section).replace(/^#+\s*/, "").toLowerCase();
      const h = lines.findIndex((l) => /^#{1,3} |^\*\*/.test(l.trim()) && l.toLowerCase().includes(target));
      if (h !== -1) {
        pos = h;
        for (let j = h + 1; j < lines.length; j++) {
          if (/^#{1,3} |^---/.test(lines[j])) break;
          pos = j;
        }
      }
    }
    if (pos === -1) {
      residual.push(fact);
      continue;
    }
    lines.splice(pos + 1, 0, line);
    inserted++;
  }

  for (let i = 0; i < missing.length; i++) {
    if (!handled.has(i + 1)) residual.push(missing[i]);
  }
  return { report: lines.join("\n"), inserted, paraphrased, residual };
}

// ── the pipeline ─────────────────────────────────────────────────────────
/** One retry on transient platform errors (5xx, timeouts): observed twice
 *  in live testing (502, 503) on an otherwise healthy instance. A blip
 *  should cost 15 seconds, not the whole completeness pass. */
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

/** query: async (message) => modelText. Returns the patched report plus
 *  auditable stats; throws nothing outward beyond what query throws. */
export async function ensureCompleteness(query, documents, report) {
  const extractionMsg = buildExtractionMessage(documents);
  const [a, b] = await Promise.all([tryQuery(query, extractionMsg), tryQuery(query, extractionMsg)]);
  const ledger = unionFacts([parseFacts(a), parseFacts(b)]);

  let current = report;
  let missing = ledger.filter((f) => !isCovered(makeReportIndex(current), f));
  const stats = {
    ledger: ledger.length,
    initiallyMissing: missing.length,
    inserted: 0,
    paraphrased: 0,
    rounds: 0,
  };

  for (let round = 0; round < 2 && missing.length; round++) {
    stats.rounds++;
    const patchText = await tryQuery(query, buildPatchMessage(documents, current, missing));
    const r = applyPatches(current, patchText, missing);
    current = r.report;
    stats.inserted += r.inserted;
    stats.paraphrased += r.paraphrased;
    const idx = makeReportIndex(current);
    missing = r.residual.filter((f) => !isCovered(idx, f));
  }

  stats.residual = missing.map((f) => f.text);
  return { report: current, stats };
}
