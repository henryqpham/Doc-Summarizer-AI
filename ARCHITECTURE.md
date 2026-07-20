# How this app works (the simple version)

## The one-sentence version

You drop a document onto a web page; a small helper program on your own
computer carries it to NASA's approved AI service (Ask Sage), asks the AI to
summarize it, and brings the answer back to your screen.

## The three pieces

```
 ┌──────────────┐        ┌──────────────────┐        ┌─────────────────┐
 │  The page in │        │  The helper on   │        │   Ask Sage      │
 │ your browser │ ◀────▶ │  your computer   │ ◀────▶ │ (NASA's AI      │
 │  (the UI)    │        │  (the "server")  │        │  service)       │
 └──────────────┘        └──────────────────┘        └─────────────────┘
  what you see            the middleman               where the AI lives
```

1. **The page in your browser** — everything you see: the drop zone, the file
   list, the summary cards. It lives in the `public/` folder. It's just a
   display; it isn't allowed to talk to Ask Sage and never sees any passwords.

2. **The helper program (the "server")** — starts when you run `npm start`.
   It runs *only on your computer* and does three jobs: shows the page to your
   browser, keeps the Ask Sage key (like a badge that proves who you are),
   and carries documents back and forth. Main file: `server.mjs`.

3. **Ask Sage** — NASA's approved AI service, running on NASA's systems.
   It does the two hard jobs: pulling the text out of a PDF/Word file, and
   writing the summary with an approved AI model.

## What happens when you drop a file

1. The page hands the file to the helper.
2. The helper sends it to Ask Sage: *"pull the text out of this."*
3. Ask Sage sends back plain text. The page shows **"9,138 characters read"**
   — a sanity check that reading actually worked. (A tiny number means the
   document couldn't be read, and the app stops instead of guessing.)
4. **Last week's report** (the file you downloaded back then) goes through
   the same read step, from its own box at the top of the panel. It rides
   along as reference material — so when the new summary says a status
   improved or lists "key changes since last week," the AI is comparing
   against what you actually reported, not inventing a memory. On a true
   first report you tick a box saying there's no previous week, and the AI
   is told so.
5. When you click **Summarize**, the helper sends Ask Sage this week's text
   (plus last week's report as reference) and an instruction sheet:
   *"summarize this into exactly this email format, judging trends against
   the previous report."* The instruction sheet lives in `lib/template.mjs`
   — change that file and you change the shape of every summary.
6. The answer comes back and appears as a card you can edit, copy, or
   download. **Compare weeks** works the same way, with a different
   instruction sheet: *"here are two weekly reports — list what changed."*

## Why the middleman exists

Two reasons, both boring but important:

- **Browsers aren't allowed to call Ask Sage directly.** Web browsers follow
  a safety rule (called CORS) where a page may only call services that have
  said "pages like you are welcome." Ask Sage doesn't say that, so the call
  must come from a normal program instead — that's the helper.
- **The key stays out of the browser.** The badge/key sits in a file called
  `.env` on your computer, is read only by the helper, and never reaches the
  page. Nothing you can click, view-source, or bookmark contains it.

## What gets stored where

- **Your computer: nothing.** No database, no saved copies, no logs of
  document contents. A document lives in memory only while it's being worked
  on. Close the tab and it's gone — which is why "last week's report" has to
  be re-opened from the file you downloaded last week.
- **Ask Sage: their normal history.** Like any chat service, Ask Sage keeps a
  record of what was sent to it. That's the approved place for this material —
  but it's why the honest claim is "nothing is stored *on this computer*,"
  not "nothing is stored anywhere."

## Why every summary comes out identical

The AI is asked to be completely predictable (a setting called
**temperature**, set to zero). When the AI writes, it internally rates every
possible next word by how likely it is; temperature zero means "always take
the top-rated word, never improvise." Same document in → same summary out,
word for word. For a weekly report tool that's exactly what you want: no
surprises, and next week's comparison sees real changes, not reworded ones.

## The folder, in one glance

| What | Where | In plain terms |
|---|---|---|
| The screen you see | `public/` | the web page and its look |
| The helper program | `server.mjs` | the middleman with the badge |
| Talking to Ask Sage | `lib/asksage.mjs` | knows how to phrase requests to the AI service |
| The summary format | `lib/instructions.txt` | ⭐ plain text file holding the email structure (private, like `.env`; `lib/instructions.example.txt` is the placeholder) |
| The prompt assembly | `lib/template.mjs` | wraps documents + rules + the format into one request |
| Reading your settings | `lib/env.mjs` | loads `.env` and explains what's wrong if it's broken |
| Your key + settings | `.env` | private, stays on this computer, never shared |
| Odd jobs | `tools/` | diagnostics and a full live test |
