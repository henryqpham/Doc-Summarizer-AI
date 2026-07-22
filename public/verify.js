// public/verify.js — "Source check": matches every line of a summary back to
// the passages in the source documents it most likely came from, entirely in
// the browser. Nothing leaves the machine: the engine scores lines against
// the already-extracted document text that app.js keeps in memory.
//
// WHAT IT IS / IS NOT: a lexical matcher, not a fact-checker. It keys on the
// tokens that survive paraphrase — numbers, dates, names — and reports where
// those words were FOUND. A green dot means "these words exist in your
// documents", never "this sentence is true"; the reader stays the judge.
// The strong signal is the red dot: a line whose numbers and names appear in
// NO source document is exactly what a fabricated or mis-extracted line
// looks like.
//
// Two layers:
//   1. Engine (browser + Node): buildIndex(sources) + checkBlock(text, index).
//      Node can import this file (like markdown.js) so the scoring is
//      testable offline: `node -e "import('./public/verify.js')..."`.
//   2. Decorator (browser only): Verify.attach({preview, container, sources})
//      walks a rendered .summary-preview, adds a colored dot per checkable
//      line, a per-card tally strip, and a click-to-open source panel.
//
// SECURITY: identical rules to the rest of the front-end — document text and
// summary text are untrusted; every node is built with createElement /
// createTextNode / textContent. Zero innerHTML. No storage, no network.
(function (root, factory) {
  "use strict";
  const V = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = V;
  if (root) root.Verify = V;
})(
  typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null,
  function () {
    "use strict";

    // ── tunables (calibrate against a real report + its real documents) ──
    const FOUND_MIN = 0.6; // coverage ≥ this → "found"
    const PARTIAL_MIN = 0.3; // coverage ≥ this → "partly found"
    const MIN_CONTENT_TOKENS = 3; // shorter lines are "too short to check"
    const MAX_PASSAGES = 3; // passages shown per sentence
    const RESIDUAL_GAIN_MIN = 0.08; // stop adding passages below this gain
    const NUMBER_WEIGHT = 3; // numbers/dates survive paraphrase best
    const CAPITALIZED_WEIGHT = 2; // names/acronyms (proper-noun proxy)

    // ── "what was left out" tunables (reverse direction) ──
    // Deliberately QUIET to start (user decision): a source sentence is only
    // surfaced as possibly-left-out when it carries a NUMBER/date or a
    // risk/change CUE word AND the report doesn't represent it. Precision
    // over recall — a short trustworthy list beats a noisy complete one,
    // because a leftovers list that cries wolf gets ignored wholesale.
    const LEFTOUT_COVERAGE_MAX = PARTIAL_MIN; // at/above this = represented enough
    const LEFTOUT_MAX_PER_DOC = 4;
    const LEFTOUT_MAX_TOTAL = 10;
    const LEFTOUT_SIM_MAX = 0.6; // drop a candidate this similar to a shown one

    // Risk / change / decision words that mark a status line as report-worthy
    // (Edmundson "cue" method). Scanned on raw text, so stopword cues like
    // "completed" still count. Kept tight — "issue(s)" excluded, it fires on
    // nearly every status sentence and would flood the list.
    const CUE_WORDS = new Set([
      "risk", "risks", "fail", "failed", "failure", "fails", "slip", "slipped",
      "slipping", "delay", "delayed", "delays", "blocked", "blocker", "blockers",
      "blocking", "concern", "concerns", "critical", "escalate", "escalated",
      "escalation", "overrun", "behind", "stopped", "halt", "halted", "missed",
      "cancelled", "canceled", "deferred", "waived", "waiver", "breach",
      "exceeded", "exceeds", "decision", "decisions", "decided", "approved",
      "approval", "milestone", "milestones", "first", "anomaly", "shortfall",
      "descope", "descoped", "unresolved", "noncompliant", "nonconformance",
    ]);
    // If one of these precedes a cue within 2 words, the cue is negated
    // ("no delay", "risk avoided") and doesn't count.
    const NEGATORS = new Set(["no", "not", "without", "avoided", "avoid", "resolved", "zero", "never"]);

    // Common words that match everywhere and prove nothing.
    const STOPWORDS = new Set([
      "the", "and", "for", "are", "was", "were", "not", "but", "its", "his",
      "her", "she", "him", "has", "have", "had", "been", "being", "will",
      "would", "should", "could", "can", "may", "might", "must", "shall",
      "this", "that", "these", "those", "with", "from", "into", "over",
      "under", "between", "during", "after", "before", "against", "about",
      "above", "below", "through", "each", "per", "all", "any", "some",
      "such", "only", "more", "most", "other", "than", "then", "when",
      "where", "which", "while", "who", "whom", "why", "how", "there",
      "here", "they", "them", "their", "our", "your", "you", "also", "both",
      "very", "too", "now", "new", "due", "via", "off", "out", "own", "same",
      "just", "week", "weeks", "weekly", "report", "reporting", "team",
      "teams", "continue", "continued", "continues", "remain", "remains",
      "remained", "ongoing", "planned", "scheduled", "completed", "complete",
      "currently", "toward", "towards", "including", "included", "provided",
      "support", "supporting", "supported", "status", "issue", "issues",
      "work", "working", "worked", "activity", "activities", "item", "items",
    ]);

    // Sentence-ending periods that aren't ("testing on 7/20. Orion has…"
    // must split; "approx. 140 days" must not).
    const ABBREVS = new Set([
      "vs", "approx", "etc", "no", "inc", "co", "corp", "dr", "mr", "ms",
      "mrs", "jr", "sr", "st", "dept", "est", "min", "max", "fig", "ref",
    ]);

    // ── tokenizing ────────────────────────────────────────────────────────
    // One token per whitespace-separated word, normalized for matching:
    // numbers keep digits and internal ./:- ("10/15", "-138" → "138", "7:30",
    // "hb-2"); words drop everything but letters/digits. Emoji, arrows, and
    // pure punctuation vanish (no alphanumerics survive).
    function tokenize(text) {
      const out = [];
      for (const raw of String(text).split(/\s+/)) {
        const trimmed = raw.replace(/^[^A-Za-z0-9~$(+-]+/, "").replace(/[^A-Za-z0-9%)]+$/, "");
        if (!trimmed) continue;
        let key;
        const hasDigit = /\d/.test(trimmed);
        if (hasDigit) {
          key = trimmed.toLowerCase().replace(/[^0-9a-z./:-]/g, "").replace(/^[./:-]+|[./:-]+$/g, "");
        } else {
          key = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "");
        }
        if (!key) continue;
        if (!hasDigit && (key.length < 3 || STOPWORDS.has(key))) continue;
        out.push({
          key,
          raw: trimmed,
          isNumber: hasDigit,
          weight: hasDigit ? NUMBER_WEIGHT : /^[A-Z]/.test(trimmed) ? CAPITALIZED_WEIGHT : 1,
        });
      }
      return out;
    }

    // ── sentence splitting ────────────────────────────────────────────────
    // Newlines always split (source documents are line-structured); within a
    // line, split after ./!/? followed by whitespace and a capital/digit,
    // then re-join known-abbreviation false splits.
    function splitSentences(text) {
      const out = [];
      for (const line of String(text).split(/\n+/)) {
        const t = line.trim();
        if (!t) continue;
        const parts = t.split(/(?<=[.!?])\s+(?=[A-Z0-9("'“‘])/);
        for (const part of parts) {
          const prev = out.length ? out[out.length - 1] : "";
          const m = /([A-Za-z]+)\.$/.exec(prev);
          if (m && ABBREVS.has(m[1].toLowerCase())) {
            out[out.length - 1] = prev + " " + part;
          } else if (part.trim()) {
            out.push(part.trim());
          }
        }
      }
      return out;
    }

    // ── index over the source documents ──────────────────────────────────
    // Sources: [{name, text}] → overlapping 2-sentence windows (stride 1),
    // an inverted token→window index, document frequencies for IDF, and a
    // corpus-wide set of number tokens (the fabricated-number tripwire).
    function buildIndex(sources) {
      const windows = []; // {source, passage, tokens:Set}
      const postings = new Map(); // token key -> [window index]
      const df = new Map(); // token key -> window count
      const numbers = new Set(); // every number token in any document

      for (const src of sources || []) {
        const sentences = splitSentences(src.text || "");
        for (let i = 0; i < sentences.length; i++) {
          const passage = sentences[i] + (i + 1 < sentences.length ? " " + sentences[i + 1] : "");
          const tokens = new Set();
          for (const tok of tokenize(passage)) {
            tokens.add(tok.key);
            if (tok.isNumber) numbers.add(tok.key);
          }
          const idx = windows.length;
          windows.push({ source: src.name, passage, tokens });
          for (const key of tokens) {
            df.set(key, (df.get(key) || 0) + 1);
            let list = postings.get(key);
            if (!list) postings.set(key, (list = []));
            list.push(idx);
          }
        }
      }
      return { windows, postings, df, numbers, n: windows.length };
    }

    function idf(index, key) {
      const d = index.df.get(key) || 0;
      return Math.log(1 + (index.n - d + 0.5) / (d + 0.5));
    }

    // ── special lines the checker must not flag ───────────────────────────
    // These are the app's own honest artifacts, not model claims.
    function specialNote(text) {
      const t = text.trim().replace(/\s+/g, " ");
      // Bare, or behind a bold label ("Administrator Engagement: Not stated…").
      if (/(^|: )not stated in document\.?$/i.test(t)) {
        return "Placeholder — the documents really didn't state this. Nothing to check.";
      }
      if (/^first report[.\s—-]+no prior week to compare\.?$/i.test(t)) {
        return "Standard first-report note added by the rules. Nothing to check.";
      }
      if (/^notes for the week ending /i.test(t)) {
        return "The date on this line is filled in by the app — that's by design.";
      }
      if (/^sir$/i.test(t)) {
        return "Opening line of the report format — nothing to check.";
      }
      return null;
    }

    // ── scoring one sentence ──────────────────────────────────────────────
    function checkSentence(sentence, index) {
      const toks = tokenize(sentence);
      const content = toks.filter((t, i, arr) => arr.findIndex((x) => x.key === t.key) === i);
      if (content.length < MIN_CONTENT_TOKENS) {
        return { text: sentence, verdict: "short", coverage: 0, matches: [], missingNumbers: [] };
      }

      // Fabricated-number tripwire: a number that exists in NO document can
      // never be "found", whatever the word overlap says.
      const missingNumbers = content
        .filter((t) => t.isNumber && !index.numbers.has(t.key))
        .map((t) => t.raw);

      const totalWeight = content.reduce((s, t) => s + t.weight * idf(index, t.key), 0);

      // Candidate windows: anything sharing at least one content token.
      const candidates = new Set();
      for (const t of content) {
        const list = index.postings.get(t.key);
        if (list) for (const w of list) candidates.add(w);
      }

      // Greedy residual coverage: best window first, then the best window
      // for the tokens still unmatched — a line synthesized from two
      // documents gets passages from both.
      let remaining = content.slice();
      let covered = 0;
      const matches = [];
      while (remaining.length && matches.length < MAX_PASSAGES && candidates.size) {
        let best = null;
        let bestGain = 0;
        let bestHit = null;
        for (const w of candidates) {
          const win = index.windows[w];
          let gain = 0;
          const hit = [];
          for (const t of remaining) {
            if (win.tokens.has(t.key)) {
              gain += t.weight * idf(index, t.key);
              hit.push(t);
            }
          }
          if (gain > bestGain) {
            bestGain = gain;
            best = w;
            bestHit = hit;
          }
        }
        if (!best && best !== 0) break;
        if (totalWeight > 0 && bestGain / totalWeight < RESIDUAL_GAIN_MIN && matches.length) break;
        const win = index.windows[best];
        matches.push({
          source: win.source,
          passage: win.passage,
          matched: bestHit.map((t) => t.raw),
        });
        covered += bestGain;
        const hitKeys = new Set(bestHit.map((t) => t.key));
        remaining = remaining.filter((t) => !hitKeys.has(t.key));
        candidates.delete(best);
      }

      const coverage = totalWeight > 0 ? covered / totalWeight : 0;
      let verdict = coverage >= FOUND_MIN ? "found" : coverage >= PARTIAL_MIN ? "partial" : "none";
      if (missingNumbers.length) verdict = "none";
      return { text: sentence, verdict, coverage, matches, missingNumbers };
    }

    // ── scoring one rendered line/row (may hold several sentences) ───────
    // The dot shows the WORST sentence verdict; the panel shows each
    // sentence's own result.
    const RANK = { none: 0, partial: 1, found: 2 };
    function checkBlock(text, index) {
      // A label-only line ("Key Changes Since Last Week:") is structure from
      // the report format, not a claim — no dot at all.
      if (/^[A-Za-z][A-Za-z0-9 ,/&'’()-]{0,60}:$/.test(text.trim())) {
        return { verdict: "skip", sentences: [] };
      }
      const note = specialNote(text);
      if (note) return { verdict: "note", note, sentences: [] };
      const parts = splitSentences(text);
      const sentences = parts.map((s) => checkSentence(s, index));
      const scored = sentences.filter((s) => s.verdict !== "short");
      if (!scored.length) {
        return { verdict: "short", sentences };
      }
      let worst = "found";
      for (const s of scored) {
        if (RANK[s.verdict] < RANK[worst]) worst = s.verdict;
      }
      return { verdict: worst, sentences };
    }

    // ── "what was left out": the SAME matcher, run in reverse ─────────────
    // Forward asks "is this report line in the documents?"; reverse asks "is
    // this document sentence in the report?". A salient source sentence with
    // no representation in the report is a possible omission.
    function hasCueWord(sentence) {
      const words = sentence.toLowerCase().match(/[a-z]+/g) || [];
      for (let i = 0; i < words.length; i++) {
        if (!CUE_WORDS.has(words[i])) continue;
        if (NEGATORS.has(words[i - 1]) || NEGATORS.has(words[i - 2])) continue;
        return true;
      }
      return false;
    }

    // Email routing metadata: To/Cc/From/Sent header lines, address lists,
    // reply banners. The inputs are often Outlook exports, and this boilerplate
    // carries names/dates that trip the salience gate but is never report
    // content — flagging it as "left out" is pure noise. Skipped, not scored.
    const HEADER_LABEL = /^\s*(sent|from|to|cc|bcc|subject|date|importance|sensitivity|attachments?|reply-to|received|classification)\s*:/i;
    const EMAIL_ADDR = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    const REPLY_BANNER = /^\s*on\s.+\swrote\s*:/i;
    function isBoilerplate(sentence) {
      return EMAIL_ADDR.test(sentence) || HEADER_LABEL.test(sentence) || REPLY_BANNER.test(sentence);
    }

    function jaccard(a, b) {
      if (!a.size || !b.size) return 0;
      let inter = 0;
      const small = a.size < b.size ? a : b;
      const big = small === a ? b : a;
      for (const k of small) if (big.has(k)) inter++;
      return inter / (a.size + b.size - inter);
    }

    // Salience of a source sentence: summed weight×IDF "significance mass"
    // (Luhn), plus the number/cue gate that decides whether it's worth
    // showing at all. `keys` is its token set, used for de-duplication.
    function salienceOf(sentence, srcIndex) {
      const seen = new Set();
      const content = [];
      for (const t of tokenize(sentence)) {
        if (seen.has(t.key)) continue;
        seen.add(t.key);
        content.push(t);
      }
      let score = 0;
      let hasNumber = false;
      for (const t of content) {
        score += t.weight * idf(srcIndex, t.key);
        if (t.isNumber) hasNumber = true;
      }
      const worth = content.length >= MIN_CONTENT_TOKENS && (hasNumber || hasCueWord(sentence));
      return { worth, score, hasNumber, keys: seen };
    }

    // buildLeftouts(sources, reportText) → [{doc, items:[{sentence,context}]}]
    // sources tagged {prior:true} (last week's report) are reference material,
    // never checked for omission. Ranked by salience, de-duplicated across
    // documents, capped per-doc and overall so the list stays short.
    function buildLeftouts(sources, reportText) {
      const active = (sources || []).filter((s) => !s.prior && s.text);
      if (!active.length) return [];
      const srcIndex = buildIndex(active);
      const reportIndex = buildIndex([{ name: "__report__", text: reportText }]);

      const candidates = [];
      for (const src of active) {
        const sentences = splitSentences(src.text);
        for (let i = 0; i < sentences.length; i++) {
          const sentence = sentences[i];
          if (isBoilerplate(sentence)) continue;
          const sal = salienceOf(sentence, srcIndex);
          if (!sal.worth) continue;
          const chk = checkSentence(sentence, reportIndex);
          if (chk.verdict === "short") continue;
          // Numbers are the paraphrase-resistant anchor. A sentence carrying a
          // figure counts as covered when EITHER every figure is in the report,
          // OR the sentence is otherwise well-covered (a present fact that only
          // dropped a minor date shouldn't surface). Only a missing figure on a
          // poorly-covered sentence is a real omission. Cue-only sentences (no
          // number) fall back to plain token coverage.
          if (sal.hasNumber) {
            if (!chk.missingNumbers.length || chk.coverage >= FOUND_MIN) continue;
          } else if (chk.coverage >= LEFTOUT_COVERAGE_MAX) {
            continue;
          }
          const context = [sentences[i - 1], sentence, sentences[i + 1]].filter(Boolean).join(" ");
          candidates.push({ doc: src.name, sentence, context, salience: sal.score, keys: sal.keys });
        }
      }
      candidates.sort((a, b) => b.salience - a.salience);

      // Greedy MMR: skip a candidate too similar to one already kept, so a
      // fact repeated across the ~7 documents appears once.
      const shown = [];
      for (const c of candidates) {
        if (shown.length >= LEFTOUT_MAX_TOTAL) break;
        if (shown.some((s) => jaccard(s.keys, c.keys) >= LEFTOUT_SIM_MAX)) continue;
        shown.push(c);
      }

      const byDoc = new Map();
      for (const c of shown) {
        let g = byDoc.get(c.doc);
        if (!g) byDoc.set(c.doc, (g = []));
        if (g.length < LEFTOUT_MAX_PER_DOC) g.push(c);
      }
      return Array.from(byDoc, ([doc, items]) => ({ doc, items }));
    }

    // ── best-of-N selection ───────────────────────────────────────────────
    // The gateway is nondeterministic at temperature 0 (same inputs → visibly
    // different reports). Rather than fight that, generate a few candidates
    // and keep the best measured one, converting variance into a search space.
    // scoreCandidate rates one summary's TEXT (no DOM needed) so it can run on
    // raw candidates before any is rendered.
    function scoreCandidate(summaryText, sources) {
      const index = buildIndex(sources);
      let ungrounded = 0;
      for (const raw of String(summaryText).split(/\n+/)) {
        const line = raw.trim();
        if (!line) continue;
        if (checkBlock(line, index).verdict === "none") ungrounded++;
      }
      const groups = buildLeftouts(sources, summaryText);
      const omissions = groups.reduce((n, g) => n + g.items.length, 0);
      return { ungrounded, omissions, length: String(summaryText).length };
    }

    // selectBest([summaryText…], sources) → {index, summary, score, all}
    // Thresholded lexicographic ordering (the gate-then-rank rule): first
    // prefer candidates with NO ungrounded lines (a hallucinated line is the
    // worst failure); among those, fewest salient omissions; then the tighter
    // one (concision discourages a padded/over-copied draft). Deterministic:
    // the same candidate set always yields the same winner.
    function selectBest(candidates, sources) {
      const scored = candidates.map((summary, index) => ({
        index, summary, ...scoreCandidate(summary, sources),
      }));
      const clean = scored.filter((c) => c.ungrounded === 0);
      const pool = clean.length ? clean : scored;
      pool.sort((a, b) =>
        a.ungrounded - b.ungrounded || a.omissions - b.omissions || a.length - b.length);
      const winner = pool[0];
      return { index: winner.index, summary: winner.summary, score: winner, all: scored };
    }

    // ══ decorator (browser only) ══════════════════════════════════════════
    // Display philosophy (user decision, 21 Jul 2026): NO scoreboard, no
    // green/amber/red grading on the report — a verified line looks like a
    // normal line. Every line answers "where did this come from?" on click;
    // only a line that could not be matched at all carries a quiet
    // "double-check" note. Exceptions are marked; everything else is clean.
    const PANEL_VERDICTS = {
      found: "", // the passages speak for themselves
      partial: "Only partly matched — compare the wording against the passage below.",
      none: "We couldn't match this line to your documents — double-check it against the original before sending.",
      short: "Too short to match against the documents.",
    };

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }

    // Passage text with the matched words highlighted — built token by
    // token with createTextNode/<mark>, never innerHTML.
    function passageNode(passage, matchedRaw) {
      const p = el("p", "src-passage");
      if (!matchedRaw.length) {
        p.textContent = passage;
        return p;
      }
      const escaped = matchedRaw
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .sort((a, b) => b.length - a.length);
      const re = new RegExp("(" + escaped.join("|") + ")", "gi");
      let last = 0;
      let m;
      while ((m = re.exec(passage))) {
        if (m.index > last) p.appendChild(document.createTextNode(passage.slice(last, m.index)));
        p.appendChild(el("mark", null, m[0]));
        last = m.index + m[0].length;
      }
      if (last < passage.length) p.appendChild(document.createTextNode(passage.slice(last)));
      return p;
    }

    // attach({preview, container, sources}) → {refresh, closePanel}
    // container is the .result-body that holds the preview; the tally strip
    // and the source panel are created inside it on demand.
    function attach(opts) {
      const preview = opts.preview;
      const container = opts.container;
      const sources = opts.sources || [];
      let index = null;
      let panelHost = null; // the wrapper inserted into the preview flow
      let activeLine = null;

      function closePanel() {
        if (panelHost) {
          panelHost.remove();
          panelHost = null;
        }
        if (activeLine) {
          activeLine.classList.remove("src-active");
          activeLine = null;
        }
      }

      function showPanel(lineEl, lineText, result) {
        closePanel();
        const panel = el("aside", "source-panel");
        panel.setAttribute("aria-label", "Where this line came from");

        const head = el("div", "source-panel-head");
        head.appendChild(el("h4", null, "Where this came from"));
        const close = el("button", "btn btn-secondary", "Close");
        close.type = "button";
        close.addEventListener("click", closePanel);
        head.appendChild(close);
        panel.appendChild(head);

        panel.appendChild(el("p", "src-quoted", "“" + lineText.trim() + "”"));

        if (result.verdict === "note") {
          panel.appendChild(el("p", "src-verdict src-verdict-note", result.note));
        } else {
          const multi = result.sentences.filter((s) => s.verdict !== "short").length > 1;
          for (const s of result.sentences) {
            if (s.verdict === "short" && multi) continue;
            const sec = el("div", "src-sentence");
            if (multi) sec.appendChild(el("p", "src-sentence-text", s.text));
            if (PANEL_VERDICTS[s.verdict]) {
              sec.appendChild(el("p", "src-verdict src-verdict-" + s.verdict, PANEL_VERDICTS[s.verdict]));
            }
            if (s.missingNumbers.length) {
              sec.appendChild(
                el("p", "src-verdict src-verdict-none",
                  "Heads up: " + s.missingNumbers.join(", ") +
                  (s.missingNumbers.length === 1 ? " doesn't" : " don't") +
                  " appear in any document.")
              );
            }
            for (const m of s.matches) {
              sec.appendChild(el("span", "src-source", m.source));
              sec.appendChild(passageNode(m.passage, m.matched));
            }
            if (!s.matches.length && s.verdict !== "short") {
              sec.appendChild(el("p", "src-passage", "No close passage found in any document."));
            }
            panel.appendChild(sec);
          }
        }

        panel.appendChild(
          el("p", "src-footnote",
            "A match means these words were found in your documents — it can't tell " +
            "whether the sentence uses them correctly. When it matters, read the passage.")
        );

        // The panel opens INLINE, directly under the clicked line — the
        // source is always beside the sentence being checked, never a
        // scroll away. Wrapper depends on where the line lives: a plain
        // block after a paragraph, a marker-less <li> inside a list, a
        // full-width row inside a table.
        if (lineEl.tagName === "LI") {
          panelHost = document.createElement("li");
          panelHost.className = "src-panel-li";
          panelHost.appendChild(panel);
        } else if (lineEl.tagName === "TR") {
          panelHost = document.createElement("tr");
          const td = document.createElement("td");
          td.colSpan = lineEl.cells.length;
          td.className = "src-panel-cell";
          td.appendChild(panel);
          panelHost.appendChild(td);
        } else {
          panelHost = panel;
        }
        lineEl.insertAdjacentElement("afterend", panelHost);
        activeLine = lineEl;
        lineEl.classList.add("src-active");
        // Make sure the freshly opened panel is actually on screen when the
        // clicked line sits at the bottom of the viewport.
        panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }

      // The checkable units of a rendered preview: paragraphs, bullet items,
      // and table body rows. Headings, rules, and header rows are structure.
      function collectTargets() {
        const targets = [];
        for (const child of Array.from(preview.children)) {
          const tag = child.tagName;
          if (tag === "P") {
            targets.push({ el: child, text: child.textContent, dotHost: child });
          } else if (tag === "UL") {
            for (const li of Array.from(child.children)) {
              targets.push({ el: li, text: li.textContent, dotHost: li });
            }
          } else if (tag === "TABLE") {
            const tbody = child.tBodies[0];
            if (!tbody) continue;
            for (const tr of Array.from(tbody.rows)) {
              // Icon-only cells (🟡, ↔) carry no checkable words — dropping
              // them keeps the panel's quoted line readable. Cells with any
              // real text ("🟡 (testing planned)") are kept.
              const text = Array.from(tr.cells)
                .map((c) => c.textContent.trim())
                .filter((t) => /[A-Za-z0-9]/.test(t))
                .join(" · ");
              // Dot lives in the FIRST cell: next to the item name, and never
              // beside a 🟡/🔴 status where a green dot would read as status.
              const firstCell = tr.cells[0];
              if (firstCell) targets.push({ el: tr, text, dotHost: firstCell });
            }
          }
        }
        return targets;
      }

      // Report text for the reverse (coverage) direction: every leaf block
      // (paragraph, list item, heading, table cell) on its own line, so words
      // never glue across blocks ("toward 20" + "First-ever" must not fuse
      // into one token) and sentence boundaries survive.
      function reportText() {
        const parts = [];
        preview.querySelectorAll("p, li, h1, h2, h3, h4, th, td").forEach((n) => {
          parts.push(n.textContent);
        });
        return parts.join("\n");
      }

      // The "may not be in the report" panel: grouped by document, collapsed
      // by default, each item expandable to its surrounding source context.
      function renderLeftoutPanel(groups) {
        const total = groups.reduce((n, g) => n + g.items.length, 0);
        const panel = el("section", "leftout-panel");
        if (!total) {
          panel.appendChild(
            el("p", "leftout-clear", "Nothing important looks left out of the report.")
          );
          return panel;
        }
        const toggle = el("button", "leftout-toggle");
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", "false");
        toggle.appendChild(
          el("span", "leftout-toggle-text",
            "A few things from your documents that may not be in the report")
        );
        toggle.appendChild(el("span", "leftout-count", String(total)));
        const body = el("div", "leftout-body");
        body.hidden = true;
        toggle.addEventListener("click", () => {
          const open = toggle.getAttribute("aria-expanded") === "true";
          toggle.setAttribute("aria-expanded", String(!open));
          body.hidden = open;
        });
        body.appendChild(
          el("p", "leftout-intro",
            "These didn't clearly match anything in the report. Some may be covered " +
            "in different words — open one to check it against the original.")
        );
        for (const g of groups) {
          const docWrap = el("div", "leftout-doc");
          const head = el("button", "leftout-doc-head");
          head.type = "button";
          head.setAttribute("aria-expanded", "false");
          head.appendChild(el("span", "leftout-doc-name", g.doc));
          head.appendChild(el("span", "leftout-doc-count", String(g.items.length)));
          const list = el("ul", "leftout-list");
          list.hidden = true;
          head.addEventListener("click", () => {
            const open = head.getAttribute("aria-expanded") === "true";
            head.setAttribute("aria-expanded", String(!open));
            list.hidden = open;
          });
          for (const item of g.items) {
            const li = el("li", "leftout-item");
            const snip = el("button", "leftout-snippet", item.sentence);
            snip.type = "button";
            snip.title = "Show this in the document";
            const ctx = el("p", "leftout-context");
            ctx.hidden = true;
            ctx.appendChild(passageNode(item.context, [item.sentence]));
            snip.addEventListener("click", () => {
              ctx.hidden = !ctx.hidden;
            });
            li.append(snip, ctx);
            list.appendChild(li);
          }
          docWrap.append(head, list);
          body.appendChild(docWrap);
        }
        panel.append(toggle, body);
        return panel;
      }

      function refresh() {
        if (!sources.length) return;
        closePanel();
        const oldStrip = container.querySelector(".src-strip");
        if (oldStrip) oldStrip.remove();
        const oldLeft = container.querySelector(".leftout-panel");
        if (oldLeft) oldLeft.remove();
        if (!index) index = buildIndex(sources);

        let flagged = 0;
        for (const t of collectTargets()) {
          const result = checkBlock(t.text, index);
          if (result.verdict === "skip") continue; // structural label line
          if (result.verdict === "short" && !specialNote(t.text)) continue;
          const lineEl = t.el;
          const lineText = t.text;

          // Every checked line is quietly clickable — "where did this come
          // from?" is available everywhere, with no grade attached.
          lineEl.classList.add("src-line");
          lineEl.title = "Click to see where this came from";
          lineEl.addEventListener("click", (e) => {
            if (e.target instanceof Element && e.target.closest("button, .source-panel")) return;
            if (activeLine === lineEl) closePanel();
            else showPanel(lineEl, lineText, result);
          });

          // Only a line that could NOT be matched carries a visible marker —
          // a quiet to-do note, not a grade. Clean lines stay clean.
          if (result.verdict === "none") {
            flagged++;
            const flag = el("button", "src-flag", "double-check");
            flag.type = "button";
            flag.title = "We couldn't match this line to your documents — click to compare";
            flag.setAttribute("aria-label", "Double-check this line — click to compare with the documents");
            flag.addEventListener("click", (e) => {
              e.stopPropagation();
              if (activeLine === lineEl) closePanel();
              else showPanel(lineEl, lineText, result);
            });
            t.dotHost.appendChild(flag);
          }
        }

        // One quiet sentence above the report — never a tally.
        const strip = el("div", "src-strip");
        if (flagged) {
          strip.appendChild(
            el("span", "src-strip-note",
              flagged === 1
                ? "1 line is marked “double-check” — it couldn't be matched to your documents."
                : flagged + " lines are marked “double-check” — they couldn't be matched to your documents.")
          );
        }
        strip.appendChild(el("span", "src-strip-hint", "Click any line to see where it came from."));
        container.insertBefore(strip, container.firstChild);

        // Reverse direction: what's in the documents but not the report.
        container.appendChild(renderLeftoutPanel(buildLeftouts(sources, reportText())));
      }

      return { refresh, closePanel };
    }

    return {
      buildIndex, checkBlock, splitSentences, tokenize,
      salienceOf, buildLeftouts, scoreCandidate, selectBest, attach,
    };
  }
);
