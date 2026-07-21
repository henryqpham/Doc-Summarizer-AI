# Handoff — Document Summarizer

**Last updated:** 21 July 2026 (v3 — supersedes v2 of 20 July; v2 was deleted)

Weekly Administrator-Update generator for a NASA user, built for CUI. Drop
this week's documents (+ last week's exported report, or tick "First
report") → Ask Sage (Claude Sonnet 4.5 gov) extracts and summarizes into
the mentor's exact email format → review, copy into Outlook (rich text), or
download as dated Word/PDF/text. Local-only, zero npm dependencies.

Owner: hpham10 (intern), under mentor Christian J. Lewis (JSC-FA/Barrios).
End users are NON-TECHNICAL — all UI copy stays in plain language.

---

## 1. What changed since v2 (20–21 Jul, ALL UNCOMMITTED)

- **Compare-weeks feature fully REMOVED** (user request): tab UI, panel,
  `/api/compare`, `compareDocuments()`, `buildCompareMessage`, compare CSS,
  all doc mentions. Single "Summaries" view now. Live-verified: health OK,
  /api/compare→404, page has zero compare strings. (`.well`/`.link-btn` CSS
  kept — the Step-1 sidebar well uses them.)
- **Report restructured to the mentor's REAL skeleton** (user pasted it):
  `Sir` / `Notes for the week ending <date>.` opening (bare — no content
  summary), `# BLUF` (Overall Assessment ¶s + Administrator Engagement +
  Key Changes), Schedule/Critical Path (III and IV/V "Boots"), Watch Items
  TABLE, per-org Workforce sections, narrative Anomaly Resolution,
  restructured Weekly Highlights, Artemis II Anomaly Status table.
  Cross-Program Assessment was added on reviewer say-so then REMOVED —
  it was never in the real format.
- **Date handling:** `dateRule()` in lib/template.mjs injects the computed
  most-recent-FRIDAY (mentor convention, user decision) as the ONE
  whitelisted outside fact — fills the week-ending date in the opening line
  only when documents don't state the period; docs always win. Download
  filenames deliberately use TODAY'S date instead: `report_M_D_YYYY`
  (combined; per-file keeps `{docname}_report_` prefix to avoid collisions).
  Body date ≠ filename date is intentional and documented in app.js.
- **instructions.txt carries ~10 rounds of calibration** (see §3). It is
  gitignored, single-copy, NO BACKUP EXISTS — the most valuable artifact.

## 2. Ten rounds of format feedback — what stuck

The user iterated output vs the mentor's real sent reports via an Ask Sage
gov reviewer. Scores: 6.5 → 8.5 (vs described format) → 5.5–7 (vs the real
7/17 report) → 8.5 with-baseline. Adopted into the template:

- Measured colleague voice; facts flat ("2 weeks schedule lost"), never
  softened, never dramatized; judgment adjectives only if docs use them
  ("critical path" exempt); "issues" default noun; steady-state phrasing.
- One activity per bullet (5–12 words); `[Component] [verb] [outcome]`;
  each fact once per section; hierarchy ONLY via headings/bold labels/"- "
  bullets (markdown.js line-trims — space indentation is DESTROYED in every
  renderer; never use it).
- Status≠Trend independence; 🔴 reserved for stopped/no-path/needs-
  leadership-NOW (actively-worked-with-path = 🟡 regardless of severity —
  the boss's real table is all-yellow); Anomaly Status icons carry a 2–4
  word parenthetical basis ("🟡 (testing planned)"); per-item evidence only.
- Lead with what held; Overall Assessment = 3–6 SHORT paragraphs, one topic
  each; big decisions elevated to their own ¶ carrying the DOCUMENTS' stated
  value; Administrator-lens BLUF (decisions/risks/asks up, hardware detail
  down); engagement asks only from stated evidence (met commitments →
  appreciation; pushback/access restrictions → reinforcement).
- Problem + stated response in the same bullet (fact first, action second,
  never invented); watch-worthiness criteria; two contrastive examples
  (good week + bad week) — examples move the model more than rules.

**Round 11 (21 Jul evening, first A/B/C-bucketed round — 15A/3B/15C):**
Adopted: precision preservation (stated dates, "(+Xd)" slips, "(on
track)", Phase 1/2 structure via bold labels, quantified opportunities,
"early"/"first-ever"); Administrator Engagement fallback is now "Not
stated in document." (never "None required" — fabricated judgment);
status-gloss ban ("remains unresolved" — stated work IS the status);
major stated closures/de-risks elevate to BLUF with the documents'
numbers; critical-path Assessment must lead with the named driver+dates.
**priorRules() first-report branch rewritten (template.mjs):** the
no-prior note appears ONCE (first Key Changes bullet), documents-stated
changes listed after it (only model-derived comparisons barred — also
harmonized the steady-state rule in instructions.txt since recency wins),
Trend cells bare ↔, Status unaffected. Rejected on real-artifact grounds:
Watch Items table→bullets (skeleton has a TABLE — round-4 rerun), removing
anomaly Status icons (boss's real table HAS them), space indentation
(round-7 rerun). Reviewer again used INPUT docs as format ground truth.

**Round 12 (21 Jul late, first 7-doc run — 60-70% vs golden doc, up from
30-40%):** extraction/format/precision/critical-path confirmed working;
remaining gap = strategic elevation + synthesis. Adopted (every rule
conditioned on the DOCUMENTS stating the language): stated threat
rankings ("single greatest threat", "top schedule risk") are elevation
triggers whose wording is preserved; concrete big-decision cues
("baselined X", named-board recommendation, attached cost figure);
🔴/quantified-float items get a BLUF sentence AND their table row
("the table flags it; the BLUF explains it"); cross-program BLUF note
when the same issue appears in multiple programs' docs; Weekly Staffing
Assessment must cite the docs' specifics (unevidenced "appears adequate"
banned as a gloss); precision rule extended (headcounts/scaling, stated
open constraints, Completed:/Planned: activity lists as grouped
bullets). REJECTED: hardcoding the boss's voice ("single biggest knob",
"starting to see some dividends") as template text — round-9 boundary
holds, stated-in-docs only. Reviewer's own Bucket-C note concedes
several "missing" items may be extraction misses, not data gaps — user
to verify against the 7 inputs before classifying.

**Round 13 (21 Jul latest, 85/100 — "production-ready with 5 fixes"):**
Reviewer VERIFIED the grounding boundary itself: checked all 7 inputs,
confirmed "largest threat"/"single biggest knob" appear in none, and
withdrew them as scoreable — round-9/12 refusals vindicated (that
language is the boss's ~90-second human layer). SLS/Core Stage input
confirmed present in the 7-doc set (former #1 data gap closed).
Adopted: stated missed-milestone goals ("do not meet <date> goal") +
documents' own "RISK"/"biggest concern" labels added to BLUF elevation
cues; gloss-ban strengthened with positive frame ("working with X to
resolve" never becomes "remains unresolved" — model produced it AGAIN
post-round-11, watch for recurrence); Weekly Staffing Assessment
declared a SYNTHESIS slot derived from per-org Workforce facts
("Not stated in document." only when NO doc states workforce presence);
Anomaly Resolution placeholder now pulls failure investigations from
ANY source section ("Special Topics" etc.). REJECTED: "negative float
> 120 days → 🔴" — a severity threshold, the round-4/5/6 settled class;
boss's real table keeps actively-worked items 🟡 regardless of severity
(-138d with recovery options assessed = 🟡; severity surfaces via the
BLUF sentence carrying "biggest concern" + numbers). Same reviewer
called the same item's 🔴 "appropriate" one round earlier — color
flip-flop again proves only the boss's table calibrates colors.
Post-round addendum: the model began appending "(<filename>.docx)"
citations to report lines (likely nudged by the new carry-the-specifics
rules) — added a template rule banning file names/citations in the body;
attribution is the Source check UI's job, never the text's.

**PERMANENTLY REJECTED (do not re-adopt, reviewers keep pushing these):**
forced 🟡/🔴 mix quotas; word-replacement euphemisms ("exceeding safe
limits"→"approaching margins" = falsification); "always include positives";
filling "Not stated in document." sections (that placeholder is the
input-coverage detector); fabricating the boss's personal/process asides;
inventing strategic significance docs don't state. Reviewer track record:
right ~half the time, self-contradicting (watch-items table, opening,
assessment length) — only REAL artifacts (user-pasted skeleton, real sent
reports) settle format questions.

## 2b. Source check feature (NEW 21 Jul evening, UNCOMMITTED)

Boss ask (via user): a way to verify report lines against the source docs
without reading line-by-line. Built as **`public/verify.js`** (~450 lines,
zero deps, same UMD pattern as markdown.js). Display went through TWO
user-driven redesigns the same evening — current design (FINAL, user
decision): **no scoreboard, no green/amber/red dots** — a verified line
looks like a normal line; EVERY line is quietly clickable → "Where this
came from" panel with source passages and matched words highlighted;
ONLY a line that couldn't be matched at all gets a soft amber
"double-check" pill; one quiet sentence above the report when flags
exist, never a tally. Rationale: the tally read as a report card, and
run-to-run count variance (model nondeterminism) alarmed non-technical
readers — exceptions marked, everything else clean. The panel opens
INLINE directly under the clicked line (marker-less li in lists, colspan
row in tables) — the first side-panel design made users scroll back up
(rejected). "Partial" verdicts no longer surface on lines (were 20+ of
noise); still computed internally and shown in the panel — and the full
found/partial/none scoring stays in the engine because best-of-N
selection (planned, researched) consumes it. Design points (researched 21 Jul, 4-agent sweep):
- **Audit-first, not click-first** — the app pre-checks every line; the
  boss only inspects flagged ones. Doubles as the output-validation gap
  fix (a refusal/hallucination lights up red everywhere).
- **Engine:** IDF-weighted rare-token overlap over 2-sentence source
  windows; numbers ×3, Capitalized ×2; greedy residual coverage (multi-doc
  synthesis lines get passages from each doc); hard rule: a number found
  in NO document → red regardless of score. Thresholds FOUND≥0.6 /
  PARTIAL≥0.3 at top of verify.js — **calibration against a real report
  pending** (expect to tune 0.25-0.45 per research).
- **Honesty framing everywhere:** "found ≠ verified" — lexical match can't
  detect flipped negation/wrong attribution; UI copy says so (panel
  footnote, Limits dialog, USER-GUIDE).
- 100% client-side on the extracted text app.js already holds in memory
  (cardSources snapshot at request time; prior report included as a
  labeled source). No server changes, no storage, exports/copy untouched
  (dots live only in the preview DOM; textarea stays source of truth).
- Structural lines skipped (headings, label-only lines); placeholders and
  the injected date line get gray "nothing to check" notes. Table-row dots
  sit in the Item cell (never next to 🟡 where green would read as status).
- Verified offline: node scoring test (10/10 fictional cases) + headless-
  Edge harness screenshots (dots, red panel, green panel). NOT yet tested
  against a live summarize run. Ask Sage native citations confirmed
  unavailable (/server/query `references` is an opaque string; Anthropic
  Citations API not exposed through their gateway) — post-hoc matching is
  the right architecture, prompt-emitted quotes a possible v2.

## 3. The template system (⭐ the product)

- `lib/instructions.txt` — GITIGNORED like `.env`, hot-reloaded per request,
  `npm run check-template` validates without printing. ~500 lines now.
  **Copy manually to any new machine; make a backup — none exists.**
- Handling protocol: never print/dump it; presence-greps (`-o`) OK; small
  anchor-window reads only with user OK; never hand it to subagents;
  real-content comparisons happen in Ask Sage gov, not commercial chats.
- `lib/template.mjs`: rules() anti-injection binding → dateRule() →
  priorRules() → instructions.txt LAST (recency = template wins conflicts;
  conditional wording matters — see the first-report interplay note in §4).
- Mentor's literal artifacts in the template ("Lan", "Integ", "= ", "….")
  are intentional — preserve them.

## 4. Hard-won facts (don't re-learn)

All of v2's still hold: Ask Sage answers `/server/query`→`message`,
`/server/file`→`ret` behind a stripped metadata line (never reorder pick
lists without `npm run probe`); Node needs `--use-system-ca`; server binds
BOTH loopbacks, never wider; `-gov` suffix = government (warn-only gate);
Ask Sage retains prompt history server-side ("nothing stored ON THIS
computer"); `.env` CRLF/BOM ⇒ fake 401s; kill node via PowerShell
`Get-NetTCPConnection`, not bash job kill; headless Edge screenshots for
visual checks (can't screenshot PDFs). New since:

- **First-report mode is live-verified working** (trends ↔ "(no prior
  report)", no trajectory wording). Template steady-state phrasing rule is
  explicitly subordinated to the first-report rules — keep it that way.
- **Round-trip trap:** the PDF maps 🟡→"(Y)", ↓→"v" and loses table pipes —
  feeding the PDF back as "last week's report" silently degrades
  continuity. The .txt is the only byte-faithful format; the .doc is HTML
  masquerading as Word (extract round-trip UNTESTED). Docs/UI don't say
  which to keep yet (gap list).
- **Old-structure prior reports:** priorRules has a transition rule need —
  a pre-restructure prior report's sections don't map 1:1 (was on the
  minutes-batch list; check if applied before assuming).
- **Node floor is WRONG in docs:** `--use-system-ca` needs Node ≥22.15
  (added 23.8, backported 22.15) but engines/README/REQUIREMENTS say
  20.12 — deployment landmine, unfixed.
- **Known unfixed bugs:** lib/env.mjs:77 accepts `http://` despite its
  https-only error message; token cached forever (email mode 401 brick —
  no force-refresh on 401); model output never validated (refusals ship
  under green "Done"); e2e prior-week fixture is the OLD skeleton; e2e
  spends a live call on legacy /api/summarize no UI reaches;
  template.mjs comment still claims filenames carry the Friday (stale).
- **36-gap sweep ran 21 Jul** (6 dimensions, all cited) — the minutes-batch
  was offered but NOT confirmed applied; verify `git diff` before assuming.

## 5. Testing state (as of 21 Jul evening)

- User now tests with 7 real input docs (was 5: EGS, EVA, HLS, Orion,
  SIT; round-13 evidence confirms an SLS/Core Stage doc is among the two
  added 21 Jul — **the former #1 "missing content" gap is closed**),
  correlated against the mentor's real 7/17 report ("golden doc"). Three-bucket scoring rubric
  established: A=model issue (score), B=baseline-dependent (expected
  absent), C=missing input (inventory, don't score). A briefing message
  for the Sage reviewer encoding this was drafted 21 Jul.
- **Next tests queued:** re-run same 5 docs (big-decision/Administrator-
  lens rules landed AFTER the 5/10-scored output); ideal test = mentor's
  real 7/10 report as baseline + 5 docs vs real 7/17.
- Data-side fixes ranked: (1) real prior report in loop, (2) SLS input doc
  — DONE 21 Jul, (3) vendor/procurement status input. Remaining gap after that is the
  mentor's strategic ranking + personal asides — human by design
  (~90-second edit on the with-baseline path per reviewer).

## 6. Checks

`npm run probe` (field-mapping oracle) · `npm run check-template` (no-print
validator) · `npm run e2e` (⚠ LIVE, fixtures predate restructure) · no
offline unit suite exists · fictional fixtures only in chats (Delta
Mission/Nova Booster style — never real program data in commercial AI).

## 7. Open items

1. **Commit** — ~11 files of compare-removal + date + docs changes sit
   uncommitted (suggested message was drafted). instructions.txt invisible
   to git by design.
2. **Back up instructions.txt + .env** (single-copy, ten rounds of work).
3. Minutes-batch fixes from the gap sweep (§4 known bugs) if not applied.
4. Hours-wave: output validation (biggest safety gap: green Done on
   refusal/truncation), template-status in /api/health + UI banner,
   start.cmd launcher, Host/Origin check (text/plain CSRF on
   summarize-text), e2e refresh, offline smoke tests (pdfgen verifier
   already exists in make-test-pdf.mjs — just never pointed at real
   output), encrypted-PDF test, .doc round-trip test.
5. Decisions pending: -gov warn vs hard block · AI-disclosure footer ·
   key rotation owner · Progress-to-Closure indicators (mentor, unanswered).
6. Deployment to end-user machine — not started (Node ≥22.15!, two manual
   file copies, shortcut, printed guide).
7. **Mentor review of a real week — still the highest-value open item.**

## 8. Security invariants (never change without sign-off)

Zero npm deps · loopback only · key never in the browser · no content
logging/storage · no external requests from the UI · untrusted text into
DOM via textContent only · no browser storage · `.env` + `instructions.txt`
gitignored · CUI yes, classified never · every fact from the documents
(sole exception: computed week-ending Friday, docs win) · the human
reviewing before send is the final defense.
