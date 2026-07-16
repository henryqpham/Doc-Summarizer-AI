# Document Summarizer

Drag a document (PDF / DOCX / TXT) onto a page, get an email-ready summary back
in a fixed structure, copy it. Runs entirely on one computer against your
approved **Ask Sage** instance.

## How it works

```
  browser (127.0.0.1)                 this local Node process            Ask Sage
  ─────────────────────               ────────────────────────           ─────────
  drag file  ───────────POST bytes──▶  holds the credentials
                                       POST /user/get-token-with-api-key ──▶ token
                                       POST /server/file  (extract text) ──▶ text
                                       POST /server/query (summarize)    ──▶ summary
  show + copy ◀──────────JSON────────  
```

**The browser never talks to Ask Sage, and never sees your credentials.**

## Why a local app and not just an HTML file?

The original plan was a single self-contained `.html` file you could email. That
is **not possible**: Ask Sage returns no `Access-Control-Allow-Origin` header, so
a browser refuses to call it — from a `file://` page *or* any hosted origin.
Verify it yourself, no key required:

```bash
curl -s -i -X OPTIONS "https://api.YOUR-INSTANCE.ai/server/query" \
  -H "Origin: null" -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type,x-access-tokens" | head -25
```
No `access-control-allow-origin` in the response → the call must happen outside
the browser. Hence this local process.

The forced rewrite made things better: no bundled PDF libraries (and no
[CVE-2024-4367](https://github.com/advisories/GHSA-wgrm-67xf-hhpq)), a ~30 KB app
instead of 2 MB, credentials never in the page, and Ask Sage handles extraction —
including images, which means scanned documents may work via its OCR.

## Setup (for whoever installs this)

1. **Install [Node.js](https://nodejs.org/) 20.12 or newer** (`node --version` to check).
2. Copy `.env.example` to `.env` and fill in email, API key, and base URL.
   - ⚠️ **Save `.env` with LF line endings, not CRLF.** A trailing `\r` on the key
     causes a 401 that looks exactly like a wrong key.
3. **Find your model name** — don't guess it:
   ```bash
   npm run probe
   ```
   This authenticates, lists the models your account can actually use, and prints
   the raw API responses. Put the right one in `.env` as `ASKSAGE_MODEL`.
4. Run it:
   ```bash
   npm start
   ```
   or double-click **`start.bat`** — it launches the app and opens the browser.

**There are zero npm dependencies.** Node 20.12+ provides `fetch`, `FormData`,
`Blob`, and `process.loadEnvFile()` natively. Nothing to `npm install`, nothing to
audit, no transitive CVEs.

## For the person using it

Double-click **`start.bat`**. A browser tab opens. Drag a document in, wait, click
**Copy**, paste into your email. Close the black window when you're done.

## Configure the output

`lib/template.mjs` holds the structure the model must produce. **It currently
contains a placeholder** — replace it with your real email format. That string is
the actual product; everything else is plumbing.

Ask Sage's `/server/query` has no `system` parameter, so the instructions are
prepended to the document text as one message.

## Privacy

- **Nothing is stored on this computer.** The document lives in memory for the
  length of one request. No database, no cache, no localStorage, no logs — the
  server deliberately logs no filenames or content.
- `autocomplete="off"` on the output box stops the browser's session-restore from
  persisting the summary to disk.
- The server binds **`127.0.0.1` only** — never the LAN. It holds credentials; it
  must not be reachable by other machines.
- Requests set `dataset: "none"` (no dataset attachment or ingestion) and
  `live: 0` (no live/internet lookup), so documents don't travel further than the
  query itself.

### ⚠️ Ask Sage retains prompts

Ask Sage exposes `/user/get-user-logs` ("get your last prompts") and
`/user/get-chats`, which means **prompt and chat history is retained server-side**.
So the accurate claim is *"nothing is stored outside Ask Sage,"* not *"nothing is
stored anywhere."* That's presumably fine — Ask Sage is the approved platform —
but if retention of these particular documents is a concern, that's a question for
your security team, not a code change.

### API key handling

The key lives only in `.env` on the machine running this, and is never sent to the
browser. It is not baked into any artifact and not committed (`.env` is gitignored).
If it's ever exposed, rotate it in Ask Sage and update `.env`.

## Project layout

```
server.mjs           local server: serves the UI, holds credentials, calls Ask Sage
lib/asksage.mjs      Ask Sage client — token exchange, /server/file, /server/query
lib/template.mjs     ⚙️ the output structure  ← EDIT THIS
public/              the UI (index.html, app.js, styles.css)
tools/probe.mjs      discovery: lists models, dumps raw API responses
start.bat            double-click launcher
.env                 your credentials (gitignored, never committed)
```

## Known gaps

- **Response field names are inferred.** Ask Sage's schemas aren't publicly
  documented (docs site is an SPA; SwaggerHub 404s), so `lib/asksage.mjs` tries the
  plausible field names and fails with a precise diagnostic naming what it actually
  received. `npm run probe` settles it against the live API.
- **`live: 0` is set defensively.** Their sample uses `live: 1`; the parameter's
  exact meaning isn't documented. If it turns out not to be internet lookup, this
  is just a harmless default.
- **Scanned PDFs** depend on Ask Sage's OCR. If extraction returns nothing, the app
  says so clearly rather than summarizing an empty document.
