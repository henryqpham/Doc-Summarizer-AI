// ─────────────────────────────────────────────────────────────────────────
//  OUTPUT TEMPLATE — the fixed structure the model must produce.
//
//  ⚠️  THIS IS THE PLACEHOLDER. Swap in your real email structure.
//  This string is the whole product; everything else is plumbing around it.
//
//  Note: Ask Sage's /server/query has no separate `system` parameter, so these
//  instructions get prepended to the message ahead of the document text.
// ─────────────────────────────────────────────────────────────────────────

export const INSTRUCTIONS = [
  "You are a document summarizer for internal use.",
  "Summarize the document below into the exact structure that follows,",
  "ready to paste into an email. Output ONLY the filled-in structure —",
  "no preamble, no closing remarks, no commentary.",
  "",
  "=== REPLACE EVERYTHING BELOW WITH YOUR REAL TEMPLATE ===",
  "",
  "Subject: <one concise subject line>",
  "",
  "Summary:",
  "<2-3 sentence plain-language overview>",
  "",
  "Key Points:",
  "- <point>",
  "- <point>",
  "",
  "Action Items:",
  "- <owner> — <action> (<due date, if any>)",
].join("\n");

/** Builds the full prompt: instructions + the extracted document text. */
export function buildMessage(documentText) {
  return `${INSTRUCTIONS}\n\n=== DOCUMENT ===\n\n${documentText}`;
}

/**
 * Builds ONE prompt covering several documents. Each document is labelled
 * ("=== DOCUMENT 1 of 3: budget.pdf ===") so the model can attribute content,
 * and the model is told explicitly to produce a single combined summary —
 * without that instruction it tends to emit one template per document.
 */
export function buildMultiMessage(documents) {
  const n = documents.length;
  const sections = documents.map(
    (doc, i) => `=== DOCUMENT ${i + 1} of ${n}: ${doc.filename} ===\n\n${doc.text}`
  );
  return [
    INSTRUCTIONS,
    "",
    `There are ${n} documents below. Produce ONE combined summary covering all of them — not a separate summary per document.`,
    "",
    sections.join("\n\n"),
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
//  WEEK-OVER-WEEK COMPARISON — last week's report vs this week's.
//
//  Same placeholder caveat as INSTRUCTIONS above: adjust the section names
//  to whatever the real weekly review needs.
// ─────────────────────────────────────────────────────────────────────────

export const COMPARE_INSTRUCTIONS = [
  "You are reviewing two weekly status reports for internal use: LAST WEEK's",
  "and THIS WEEK's. Compare them and report what actually changed between the",
  "two, in the exact structure that follows, ready to paste into an email.",
  "Attribute every statement to the correct week. If a section has no entries,",
  "write 'None.' Output ONLY the filled-in structure — no preamble, no",
  "closing remarks, no commentary.",
  "",
  "Subject: Week-over-week review — <one concise topic line>",
  "",
  "Overview:",
  "<2-3 sentences: the overall trajectory since last week>",
  "",
  "New this week:",
  "- <item that appears only in this week's report>",
  "",
  "Changed since last week:",
  "- <item present in both, with what changed (dates, status, scope…)>",
  "",
  "Completed / resolved:",
  "- <item from last week that is done or no longer reported>",
  "",
  "Carried over (still open):",
  "- <item appearing in both weeks with no meaningful change>",
  "",
  "Action Items:",
  "- <owner> — <action> (<due date, if any>)",
].join("\n");

/** Builds the comparison prompt from last week's and this week's report text. */
export function buildCompareMessage(previous, current) {
  return [
    COMPARE_INSTRUCTIONS,
    "",
    `=== LAST WEEK'S REPORT: ${previous.filename || "previous report"} ===`,
    "",
    previous.text,
    "",
    `=== THIS WEEK'S REPORT: ${current.filename || "current report"} ===`,
    "",
    current.text,
  ].join("\n");
}
