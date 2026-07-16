// ─────────────────────────────────────────────────────────────────────────
//  API — one request to the Claude Messages API. Nothing is stored.
// ─────────────────────────────────────────────────────────────────────────
window.DS = window.DS || {};

DS.api = (function () {
  // Sends the extracted document text to the model and returns the formatted
  // summary string produced under the DS.template instructions.
  async function summarize(documentText) {
    const { endpoint, model, apiKey, anthropicVersion, maxTokens } = DS.config;

    const res = await fetch(`${endpoint}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": anthropicVersion,
        // Required to call the Anthropic Messages API directly from a browser.
        // (If your gov endpoint blocks browser-origin calls, this is where a
        //  CORS failure will show up — see README.)
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: DS.template.instructions,
        messages: [{ role: "user", content: documentText }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`API error ${res.status}: ${detail}`);
    }

    const data = await res.json();
    // Messages API returns `content` as an array of blocks; join the text ones.
    return (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  return { summarize };
})();
