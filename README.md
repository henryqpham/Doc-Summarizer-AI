# Document Summarizer

Drop documents into a web page and get an email-ready summary back, written
by NASA's approved Ask Sage AI. Runs on your own computer — nothing is saved,
and documents go nowhere except Ask Sage. Also compares this week's report to
last week's.

## Getting started

```bash
npm install

# copy the settings file, then fill in your Ask Sage key and URL
Copy-Item .env.example .env

npm start        # or: npm run dev  (auto-restarts while developing)
```

Then open **http://localhost:3000** in your browser.

⚠️ Set `ASKSAGE_MODEL` to a model ending in **`-gov`** — commercial models
are unsafe for CUI. Leave it blank on first run and `npm start` prints the
models you can use.

---

More: [USER-GUIDE.md](USER-GUIDE.md) (how to use it, plain language) ·
[ARCHITECTURE.md](ARCHITECTURE.md) (how it works) ·
[REQUIREMENTS.md](REQUIREMENTS.md) (limits, rules, and maintainer notes)
