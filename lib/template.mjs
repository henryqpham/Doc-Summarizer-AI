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
