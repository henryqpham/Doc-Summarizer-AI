# Document Summarizer

A dead-simple, **single-file** web tool: drag a document (PDF / DOCX / TXT / MD)
onto the page, it gets summarized by a CUI-safe Claude model, and the result
comes out in a fixed structure you can copy straight into an email.

## Privacy model

- **No database, no server, no logs.** The document lives only in the browser
  tab's memory and is gone when the tab closes.
- **The only thing that leaves the machine** is the extracted document text,
  sent directly to your government-approved Claude endpoint over HTTPS. Nothing
  else is transmitted or stored anywhere.
- The deliverable is a **single `.html` file**. The recipient double-clicks it,
  it opens in their browser — no install, no packages, no server.

## How it works

```
drag file → extract text (in-browser) → send to Claude → format → copy button
             pdf.js / mammoth              your gov endpoint    fixed template
```

## Project structure

```
Doc-Summarizer-AI/
├── src/
│   ├── index.html     # page template (build fills in the placeholders)
│   ├── styles.css     # UI styling
│   ├── config.js      # ⚙️ endpoint, model, API key, limits  ← EDIT
│   ├── template.js    # 📧 the fixed email output structure   ← EDIT
│   ├── extract.js     # PDF / DOCX / text extraction
│   ├── api.js         # Claude Messages API call
│   └── app.js         # drag-drop + orchestration + copy
├── build/build.mjs    # inlines everything → dist/summarizer.html
├── vendor/            # (optional) place to commit pinned library copies
├── dist/              # build output (the .html you send) — gitignored
└── package.json       # dev-only build dependencies
```

## Setup & build

```bash
npm install          # pulls pdf.js + mammoth (dev machine only)
npm run build        # writes dist/summarizer.html
```

Then open `dist/summarizer.html` in a browser to test, and email that one file
to whoever needs it.

## Before you build — 3 things to fill in

1. **`src/config.js`** — your gov endpoint base URL, the exact Sonnet 4.5 (gov)
   model ID, and the API key. ⚠️ The key gets **baked into the delivered file**;
   anyone who opens it can read it. Only bake in a low-risk, scoped key.
2. **`src/template.js`** — replace the placeholder with your *exact* email
   structure. This is the heart of the tool.
3. Run `npm run build` and confirm `dist/summarizer.html` works.

## ⚠️ Known risk to verify: CORS

The browser calls your Claude endpoint **directly**. That only works if the
endpoint allows browser-origin requests. Many locked-down/enterprise endpoints
do not by default. If a real request fails with a CORS error in the browser
console, the endpoint isn't configured for direct browser access and we'll need
a different approach (a small local runner). Test one real request before
shipping to the PM.

## Not built yet (next steps)

- **OCR** for scanned/image PDFs (would need a *local* OCR engine to stay CUI-safe).
- The real output template (currently a placeholder in `src/template.js`).
