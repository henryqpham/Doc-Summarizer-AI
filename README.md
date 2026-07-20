# Document Summarizer

**Drop documents in. Get an email-ready summary back. Copy, paste, send.**

Runs entirely on your own computer. Documents go only to NASA's approved
Ask Sage AI service — nowhere else, and nothing is saved locally. Built for
CUI. Zero dependencies (Node 20.12+ only).

| I want to… | Read |
|---|---|
| Use the tool | [USER-GUIDE.md](USER-GUIDE.md) — one plain-language page |
| Understand how it works | [ARCHITECTURE.md](ARCHITECTURE.md) — no jargon |
| See the limits & rules | [REQUIREMENTS.md](REQUIREMENTS.md) |
| Set it up / maintain it | this file |

## Run it

```bash
# 1. create your settings file and fill in the two values
Copy-Item .env.example .env     # ASKSAGE_API_KEY + ASKSAGE_BASE_URL

# 2. start it (prints your usable models if ASKSAGE_MODEL is blank)
npm start

# 3. open the app
#    http://localhost:3000
```

⚠️ **Model must end in `-gov`.** The model list mixes government and
commercial endpoints — sending CUI to a commercial one is a spill. The app
warns loudly if the model isn't `-gov`.

## What it does

- Summarizes one or many documents — **one combined summary** or **one per file**
- **Compare weeks** — last week's report vs this week's: new / changed / done / still open
- Edit the result, then **Copy** or download **.txt / .doc / PDF** (date-stamped)
- Clear errors instead of silent failures — the *"N characters read"* count
  exposes unreadable scans before anything gets summarized

## For maintainers

<details>
<summary><strong>Local API</strong></summary>

| Endpoint | Purpose |
|---|---|
| `POST /api/extract` | file bytes (+ `x-filename` header) → `{text, chars, filename}` |
| `POST /api/summarize-text` | `{documents: [{filename, text}, …]}` → `{summary, chars}` |
| `POST /api/compare` | `{previous, current}` → `{comparison, chars}` |
| `POST /api/summarize` | legacy one-shot: file bytes → `{summary, chars}` |
| `GET /api/health` | `{ok, model, gov}` — no secrets |

Errors are 4xx with `{error: string}`.
</details>

<details>
<summary><strong>Traps — read before changing anything</strong></summary>

- **Node needs `--use-system-ca`** (NASA TLS interception). All npm scripts
  pass it; `node server.mjs` directly fails with a bare `fetch failed`.
- **Ask Sage response fields are endpoint-specific** (verified live):
  `/server/query` answers in `message`; `/server/file` in `ret` behind a
  metadata line that gets stripped. `response` can be the literal status word
  `"OK"` — never treat it as content. Don't reorder the candidate lists in
  `lib/asksage.mjs` without re-probing (`npm run probe`).
- **CRLF or UTF-8-BOM in `.env`** corrupts values → 401s that look like a
  wrong key. `lib/env.mjs` detects and explains this.
- `npm run dev` (watch mode) does **not** reload `.env` — restart after
  editing it.
</details>

<details>
<summary><strong>Prompt design (deliberate — don't "tidy" it)</strong></summary>

- **Documents first, instructions last** — Anthropic's long-context guidance;
  measurably better on long inputs.
- Documents travel in tags with a **fresh random suffix per request**, bound
  to data-status by explicit rules — a document saying "ignore your
  instructions…" or faking a closing tag can't hijack the summary. This
  *reduces* injection risk; human review before sending is the final defense.
- Combined summaries **attribute facts to their source document**; missing
  info comes back as `"Not stated in document."` — never a guess.
- `temperature: 0` → same document in, same summary out (by design).
- The output template in `lib/template.mjs` is **still a placeholder** —
  swap in the real email format (add one filled-in example when you do).
</details>

<details>
<summary><strong>Privacy model</strong></summary>

- Nothing stored on this machine: no database, cache, browser storage, or
  content logs — documents live in memory for one request.
- The UI makes zero external requests. API calls set `dataset: "none"` and
  `live: 0` so documents don't travel further inside the platform.
- Ask Sage retains prompt history server-side — the accurate claim is
  "nothing stored *outside Ask Sage*", not "nothing anywhere."
- Server binds loopback only (`127.0.0.1` / `::1`) — never the LAN.
</details>

<details>
<summary><strong>Checks & file layout</strong></summary>

- `npm run probe` — dumps raw Ask Sage responses (auth mode, models, field
  names). Diagnostic.
- `npm run e2e` — ⚠️ **live**: sends two harmless built-in fixtures through a
  running server to the real Ask Sage. Final pre-ship check.

```
server.mjs       local server: static UI + the /api/* routes, loopback only
lib/asksage.mjs  Ask Sage client — auth, extraction, query, field parsing
lib/template.mjs ⭐ output structure — replace the placeholder
lib/env.mjs      .env loading with real diagnostics
public/          the UI (no frameworks, no external assets)
tools/           probe.mjs, e2e.mjs, make-test-pdf.mjs
```
</details>
