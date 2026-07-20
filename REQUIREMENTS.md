# Requirements & Limits

What this tool enforces, requires, and refuses. Every rule lists what happens
when it's hit and where it lives in code — if you change a rule, change it
there and update this file in the same commit.

## 1. Input limits (enforced, hard)

| Rule | Limit | When violated | Enforced in |
|---|---|---|---|
| Upload size per file | **25 MB** | Rejected client-side before upload; server refuses mid-stream too | `public/app.js` (`MAX_UPLOAD_BYTES`), `server.mjs` via `config.maxUploadBytes` |
| Total text per request (summary or comparison) | **600,000 characters** (~150k tokens), counting last week's report when attached | Clean error, **nothing is sent or truncated** | `lib/asksage.mjs` (`config.maxInputChars`) |
| JSON body size (`/api/summarize-text`, `/api/compare`) | **5 MB** | Refused before buffering | `server.mjs` (`MAX_JSON_BYTES`) |
| Minimum extracted text | **20 characters** after stripping Ask Sage's metadata header | "Extraction failed" error — never summarized | `lib/asksage.mjs` (`extractText`) |
| Minimum text per document to summarize/compare | **30 characters** | "That isn't a document/report" error — never sent to the model | `lib/asksage.mjs` (`summarizeDocuments`, `compareDocuments`) |
| Empty file | 0 bytes | Rejected client-side, never uploaded | `public/app.js` pre-flight |
| Request time | **5 min** server→Ask Sage, **6 min** browser→server, 5 s health check | Friendly timeout error; try smaller input | `lib/asksage.mjs` (`AbortSignal.timeout`), `public/app.js` (`fetchWithTimeout`) |
| Concurrency | **One** extraction and one summarization in flight at a time | Later files wait in a visible queue | `public/app.js` (sequential pump) |

## 2. Platform prerequisites (must be true to run)

| Requirement | Why |
|---|---|
| Node.js **≥ 20.12** | Native `fetch`, `FormData`, `Blob`, `process.loadEnvFile` — the zero-dependency design depends on them |
| Launch via **npm scripts** (`npm start` / `npm run dev`) | They pass `--use-system-ca`; without it, NASA's TLS interception makes every API call fail with a bare `fetch failed` |
| On the NASA network | `api.asksage.ai.nasa.gov` is internal |
| `.env` with `ASKSAGE_API_KEY` + `ASKSAGE_BASE_URL` | Validated at startup with specific diagnostics (missing / BOM / CRLF / placeholder) — `lib/env.mjs` |
| `ASKSAGE_MODEL` ending in **`-gov`** | ⚠️ Currently a **warning, not a hard block** (server console + red UI banner). Commercial models in the same list would make sending CUI a spill. If policy requires, this can be made a refusal — one check in `server.mjs`. |

## 3. Security invariants (must never change without sign-off)

| Invariant | Where |
|---|---|
| Server binds **loopback only** (`127.0.0.1` + `::1`) — never `0.0.0.0`; this process holds credentials | `server.mjs` |
| API key never reaches the browser; no secrets in `/api/health` | `server.mjs` |
| **No document content or filenames are logged or stored** — server logs, browser storage (localStorage/IndexedDB/cookies), disk: none | `server.mjs` handlers, `public/app.js` |
| Zero npm dependencies — nothing to audit, no supply chain | `package.json` |
| UI makes **no external requests** (no CDNs, fonts, analytics); all assets local | `public/` |
| Filenames/summaries only enter the DOM via `textContent` — never `innerHTML` | `public/app.js` |
| Model calls set `temperature: 0.0`, `dataset: "none"`, `live: 0` — reproducible output, no org-dataset attach, no internet lookup | `lib/asksage.mjs` (`query`) |
| Documents travel inside per-request randomized tags with data-binding rules (prompt-injection hardening — reduces, does not eliminate) | `lib/template.mjs` |
| `.env` is gitignored and never committed | `.gitignore` |

## 4. Rules of use (the human's side)

- **Review every summary before sending.** Spot-check 2–3 numbers, dates, and
  names against the source document — fluent output is not verified output.
- "Not stated in document." in an output means the source didn't contain it.
  Don't fill the blank from memory inside the tool's output — edit the email
  consciously if you know more.
- The tool is built for **CUI**; the `-gov` Ask Sage endpoint is the approved
  destination for it. The tool keeps nothing locally, and **Ask Sage retains
  prompt history server-side** like any approved platform. **Classified
  material never goes in** — that boundary belongs to classified systems.
- Last week's report — whether feeding the summary's trend/status/key-changes
  columns or the Compare tab — is always the **exported report file** you
  downloaded then; the tool deliberately remembers nothing between sessions.
- The **first-report checkbox** is for the genuine first week only. Ticking it
  when a prior report exists means trends and "key changes" have nothing real
  to be judged against — load the file instead.
- Follow your directorate's disclosure policy for AI-assisted work products.

## 5. Local API (for maintainers)

| Endpoint | Purpose |
|---|---|
| `POST /api/extract` | file bytes (+ `x-filename` header) → `{text, chars, filename}` |
| `POST /api/summarize-text` | `{documents: [{filename, text}, …], previous: {filename, text}` *(optional — last week's report as reference)*`}` → `{summary, chars}` — `chars` counts `previous` too when present |
| `POST /api/compare` | `{previous, current}` → `{comparison, chars}` — week-over-week |
| `POST /api/summarize` | legacy one-shot: file bytes → `{summary, chars}` |
| `GET /api/health` | `{ok, model, gov}` — no secrets |

Errors are 4xx with `{error: string}`.

## 6. Traps — read before changing anything

- **Ask Sage response fields are endpoint-specific** (verified live via
  `npm run probe`): `/server/query` answers in `message`; `/server/file` in
  `ret`, behind a metadata line that gets stripped. On both, `response` can be
  the literal status word `"OK"` — never treat it as content. Don't reorder
  the candidate lists in `lib/asksage.mjs` without re-probing. (This exact
  trap once shipped a confident summary of the 2-character string "OK".)
- **`node server.mjs` directly fails** with a bare `fetch failed` — only the
  npm scripts pass `--use-system-ca` (NASA TLS interception).
- **`npm run dev` does not reload `.env`** — restart after editing it.
- The prompt layout in `lib/template.mjs` (documents first, instructions
  last, randomized tags) is deliberate — the rationale is in that file's
  header comment. Don't "tidy" it.
- **Checks:** `npm run probe` (diagnostic, dumps raw API responses) and
  `npm run e2e` (⚠️ live — sends harmless built-in fixtures — a sample memo,
  a generated PDF, and a fictional prior-week report — through a running
  server to the real instance; the final pre-ship check).

## 7. Deliberately not supported

- Hosting for multiple users / LAN access (would publish credentials)
- Saving documents, summaries, or history on this machine
- Browser-only operation (Ask Sage sends no CORS headers — impossible, not a choice)
- Automatic sending of anything, anywhere — output leaves only by your copy/download
- Scanned-image PDFs are **untested**: if OCR yields no text, the tool errors
  clearly rather than summarizing an empty document
