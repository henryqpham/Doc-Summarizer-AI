# Document Summarizer — How to use it

*One page. No technical background needed.*

## What it does

You give it work documents; it writes an email-ready summary for you to
review, copy, and send. It was built for sensitive work documents (CUI) and
uses Ask Sage, NASA's approved AI service — your documents go nowhere else,
and nothing is saved on your computer.

## Starting it

Whoever set this up for you gave you a way to start it (usually a desktop
shortcut). Start it, then open your web browser to **localhost:3000** —
bookmark that. If the page says it can't reach the server, the app isn't
running: start it again, then reload the page.

## Making a summary

1. **Add last week's report** to the box at the top of the left panel — it's
   the file you downloaded last week. This is how the tool knows what "since
   last week" means: the statuses, trends, and key changes in your new report
   are judged against what you actually reported, not guessed. Writing your
   very first report? Tick the **first-report box** instead. (The Summarize
   button stays off until you've done one or the other.)
2. **Drag this week's documents** onto the panel below (or click it to choose
   files). PDF and Word work best. Several files at once is fine — they take
   turns.
3. **Glance at the green number** that appears next to each file, like
   "9,138 characters read." That's how much text was found. A tiny number on
   a big document means it couldn't be read (probably a scanned photo of
   paper) — the app will say so rather than guess.
4. Choose **one combined summary** of everything, or **each file
   separately** — then click **Summarize**.
5. The summary appears on the right, in its own **tab** (like browser
   tabs). Each new summary opens a new tab — click a tab to switch
   between summaries, or click its **×** to close one. **You can edit
   the summary right there.** Need more room? The small **‹** button at
   the top of the left panel tucks it away; the thin strip that remains
   brings it back.
6. **Copy** it into your email, or download it as a Word file, PDF, or
   plain text. Downloads are named with the day you saved them, like
   `report_7_21_2026.pdf` — keep them; next week starts by adding
   this file as "last week's report."

## Before you hit Send — the 30-second habit

- **Look for "double-check" notes.** The app quietly checks every line
  against the documents you dropped. Lines that match look completely
  normal. A line that couldn't be matched gets a small **"double-check"**
  note — read that one against the original before sending.
- **Click any line to see where it came from.** The matching passage from
  your documents opens right under it, side by side.
- **Check "what may have been left out."** The quiet panel under the summary
  lists facts from your documents — the ones with numbers, dates, or words
  like "delay" or "decision" — that don't appear in the report, grouped by
  document. You skim a short list instead of re-reading every page. Some may
  be in the report in different words; open one to check. An empty list is a
  good sign.
- **Read the summary.** You're the author of the email; the AI only drafts.
  A match means the words were *found* — it can't tell whether the
  sentence uses them correctly, so the read-through is still yours.
- **Double-check two or three numbers, dates, and names** against the
  original document.
- If it says **"Not stated in document"**, the document really didn't say —
  the tool never fills gaps with guesses.
- The notes and click-to-source view are only on your screen — they never
  appear in what you copy into the email or download.

## How the tool checks itself (for the record)

You don't need this to use the tool, but it's here if anyone ever asks how
the report is put together:

- For a combined report, the tool first builds a **checklist of the facts in
  your documents** — every number, date, dollar amount, and named risk or
  decision. After writing the report it checks that list against the text,
  and any fact that didn't make it in is added back in the right section,
  word for word from your documents. That's why a combined report takes a
  few minutes.
- The check can only add missing facts — it never rewrites or removes
  anything the report already says. Anything it still couldn't place is
  reported rather than silently dropped.
- When you load last week's report, the tool never shows it to the AI as a
  report. It turns it into a plain list of last week's facts, works out
  what changed (dates that moved, numbers that went up or down), and hands
  the AI that change list. After writing, it double-checks that no
  last-week number snuck in as if it were current — and anything from last
  week that fell out of the report shows up in its own list under the
  report, so you can confirm it was dropped on purpose.
- It still can't guarantee every sentence is correct — that's why you read
  it and check the "double-check" notes before sending. The tool finds and
  grounds; you decide.

## If something looks wrong

Every error message says what happened and what to do next. The two common
ones: a file too big (over ~25 MB — use a smaller one) and a scanned
document with no readable text. Anything else — or a red banner at the top —
close the app, start it again, reload the page, and if it persists, contact
whoever set it up for you.

*A note on what's sensitive: this tool and Ask Sage are the approved path
for CUI. Classified material stays in classified systems — never here.*
