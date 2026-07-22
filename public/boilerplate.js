// public/boilerplate.js — flags lines that are fixed wording from the report
// FORMAT itself, not derived from this week's documents: the salutation,
// the "first report" line, the "not stated in document" fallback. These are
// often correct — but sometimes they slip into a report where they don't
// belong (e.g. "Not stated in document." left in a section that should have
// been filled in, or a first-report line surviving into a later week) and
// read badly in an official email. Same "flag, don't grade" spirit as
// verify.js's source check: a flagged line isn't wrong, it's the reader's
// call — the trash icon from linedelete.js is right there to drop it.
//
// Independent of verify.js and linedelete.js; only reads text, never edits.
(function (root, factory) {
  "use strict";
  const B = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = B;
  if (root) root.Boilerplate = B;
})(
  typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null,
  function () {
    "use strict";

    // Known fixed wording from the report template — grow this list as more
    // turns up. "exact": the line's whole (trimmed, case-insensitive) text
    // must equal it. "contains": the phrase may appear anywhere in the line.
    const KNOWN = [
      { match: "exact", text: "Sir" },
      { match: "contains", text: "First report. No prior week to compare." },
      { match: "contains", text: "Not stated in document." },
    ];

    function isBoilerplate(text) {
      const lower = text.trim().toLowerCase();
      if (!lower) return false;
      return KNOWN.some((k) => {
        const needle = k.text.toLowerCase();
        return k.match === "exact" ? lower === needle : lower.includes(needle);
      });
    }

    // flag(preview) — call after every render. Marks each line (paragraph,
    // bullet, table row) that matches known fixed wording.
    function flag(preview) {
      for (const lineEl of window.PreviewLines.collect(preview)) {
        lineEl.classList.toggle("is-boilerplate", isBoilerplate(lineEl.textContent));
      }
    }

    return { flag, isBoilerplate };
  }
);
