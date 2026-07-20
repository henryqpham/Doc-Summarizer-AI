# Document Summarizer

Drop documents in a browser, get an email-ready summary back. A small local web
app that sends documents to your organization's approved **Ask Sage** instance
for text extraction and summarization (Claude Sonnet 4.5 gov). Built to handle
CUI: everything runs on your machine, and documents travel only to Ask Sage.

```
browser (localhost:3000)      local Node process           Ask Sage (approved)
────────────────────────      ──────────────────           ───────────────────
drop files ──raw bytes──▶     holds credentials
                              POST /server/file   ──▶      extracted text
                              POST /server/query  ──▶      formatted summary
review / copy / download ◀──  JSON
```

The browser never sees credentials and never talks to Ask Sage directly (its
API sends no CORS headers, so a browser can't call it anyway — that's why the
local server exists).

**Zero npm dependencies.** Node 20.12+ only.

## Setup

1. `Copy-Item .env.example .env` and fill in `ASKSAGE_API_KEY` and
   `ASKSAGE_BASE_URL` (your instance's `api.` host).
2. `npm start` — if `ASKSAGE_MODEL` is unset it prints the models your account
   can use; pick one and put it in `.env`.
   - ⚠️ **Only use a model ending in `-gov`.** The list mixes in commercial
     endpoints (`-com` or no suffix) — sending CUI to one is a spill. The
     newer, shinier models are usually the commercial ones. The server and the
     UI both warn if the model isn't `-gov`.
3. Open **http://localhost:3000**. The server never opens windows on its own.

Use `npm run dev` for watch mode while developing (note: `--watch` does not
reload `.env` — restart after editing it).

## Using it

Drag one or more PDF / DOCX / TXT files in (or click to choose). Each file is
extracted in turn and shows a **"N characters read"** count — if that number
looks absurdly small, extraction failed and nothing gets summarized. Pick
**one combined summary** (default) or **each file separately**, hit Summarize,
then edit the result if needed and **Copy** or **Download .txt / .doc / PDF**.

The output structure lives in [`lib/template.mjs`](lib/template.mjs) — that
string is the actual product; replace the placeholder with your real email
format (no code changes needed).

## Local API

| Endpoint | Purpose |
|---|---|
| `POST /api/extract` | raw file bytes (+ `x-filename` header) → `{text, chars, filename}` |
| `POST /api/summarize-text` | `{documents: [{filename, text}, …]}` → `{summary, chars}` (several docs → one combined summary) |
| `POST /api/summarize` | legacy one-shot: file bytes → `{summary, chars}` |
| `GET /api/health` | `{ok, model, gov}` — powers the UI banner; no secrets |

Errors are 4xx with `{error: string}`.

## Checks

- **`npm run probe`** — dumps raw Ask Sage responses (auth mode, model list,
  response field names). Diagnostic, not required.
- **`npm run e2e`** — ⚠️ **live**: sends two built-in harmless fixtures (a
  sample memo embedded in the script + a generated PDF) through a running
  server to the real Ask Sage instance. Final pre-ship check.

## Privacy

- **Nothing is stored on this machine** — no database, no cache, no browser
  storage, no logs; documents live in memory for one request.
- Documents go **only** to your configured Ask Sage instance. The UI makes no
  external requests of any kind. Requests set `dataset: "none"` and `live: 0`
  so documents don't travel further inside the platform.
- Nuance: Ask Sage itself retains prompt history server-side. The accurate
  claim is "nothing is stored *outside Ask Sage*", not "nothing anywhere."
- The server binds loopback only (`127.0.0.1` / `::1`) — never the LAN.

## Traps (read before touching)

- **Node needs `--use-system-ca`** to reach the API behind TLS interception —
  all npm scripts pass it. `node server.mjs` directly will fail with a bare
  `fetch failed`.
- **Ask Sage response fields are endpoint-specific** (verified live):
  `/server/query` answers in `message`; `/server/file` in `ret`, prefixed with
  a metadata line that gets stripped. On both, `response` can be the literal
  status word `"OK"` — never treat it as content blindly. Don't reorder the
  candidate lists in `lib/asksage.mjs` without re-probing.
- **A CRLF or UTF-8-BOM `.env`** corrupts values and produces 401s that look
  like a wrong key (`lib/env.mjs` detects and explains this).

## Layout

```
server.mjs       local server: static UI + the four /api/* routes, loopback only
lib/asksage.mjs  Ask Sage client — auth, extraction, query, field parsing
lib/template.mjs ⭐ the output structure — replace the placeholder
lib/env.mjs      .env loading with real diagnostics
public/          the UI (no frameworks, no external assets)
tools/           probe.mjs, e2e.mjs, make-test-pdf.mjs
```
