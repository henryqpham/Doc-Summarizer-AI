// ─────────────────────────────────────────────────────────────────────────
//  CONFIG — fill these in before building the file you send out.
// ─────────────────────────────────────────────────────────────────────────
window.DS = window.DS || {};

DS.config = {
  // Base URL of your government-approved Claude endpoint.
  // The request is sent to `${endpoint}/v1/messages`.
  // TODO: set to your gov endpoint (e.g. "https://api.anthropic.com" or your
  //       agency's authorized proxy URL).
  endpoint: "https://api.anthropic.com",

  // The exact CUI-safe Sonnet 4.5 (gov) model ID your endpoint expects.
  // TODO: confirm the precise gov model identifier — this is a placeholder.
  model: "claude-sonnet-4-5",

  // Messages API version header. Leave as-is unless your endpoint requires
  // a different value.
  anthropicVersion: "2023-06-01",

  // API key. ⚠️ This gets baked into the delivered .html file — anyone who
  // opens the file can read it. Only use a low-risk, narrowly scoped key.
  // TODO: paste your key here (or inject it during build — see build/build.mjs).
  apiKey: "PASTE_API_KEY_HERE",

  // Max length of the generated summary, in output tokens.
  maxTokens: 4096,
};
