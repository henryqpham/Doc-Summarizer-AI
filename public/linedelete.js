// public/linedelete.js — "Delete this line": a small trash icon that appears
// on hover over a paragraph, bullet, or table row in the formatted preview,
// so a reviewer can drop a line without switching to the raw-text editor.
//
// The textarea (raw Markdown) stays the single source of truth, same as
// every other consumer in this app: a delete removes that exact line from
// the textarea and asks the card to re-render, exactly like a manual edit
// would — Copy/.txt/.doc/PDF automatically see the result, no separate
// "deleted" state to keep in sync. Deletions are undoable (multi-level,
// LIFO) for the life of the card; nothing is ever silently unrecoverable.
//
// Independent of verify.js — works with or without Source check attached.
// Relies on markdown.js tagging every paragraph/li/tr with data-src-line
// (its 0-based line number in the current textarea value).
//
// SECURITY: identical rules to the rest of the front-end — every node is
// built with createElement/createElementNS/textContent. Zero innerHTML.
(function (root, factory) {
  "use strict";
  const LD = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = LD;
  if (root) root.LineDelete = LD;
})(
  typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null,
  function () {
    "use strict";

    const SVG_NS = "http://www.w3.org/2000/svg";
    // Feather "trash" — a plain, unambiguous delete glyph.
    const TRASH_PATHS = [
      "M3 6h18",
      "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
      "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
    ];

    function trashIcon() {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", "13");
      svg.setAttribute("height", "13");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.setAttribute("aria-hidden", "true");
      for (const d of TRASH_PATHS) {
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        svg.appendChild(p);
      }
      return svg;
    }

    // attach({preview, textarea, rerender, onStackChange})
    //   → { refresh, undo, undoCount }
    // preview: the .summary-preview element (rebuilt fresh on every rerender)
    // textarea: the card's raw-text source of truth
    // rerender: re-renders preview from the CURRENT textarea value (also
    //   responsible for calling this module's refresh() again afterward)
    // onStackChange(count): notified after every delete/undo so the caller
    //   can show/hide its own Undo control
    function attach(opts) {
      const preview = opts.preview;
      const textarea = opts.textarea;
      const rerender = opts.rerender;
      const onStackChange = opts.onStackChange || function () {};
      const stack = []; // [{index, text}], most recently deleted last

      function deleteAt(srcLine) {
        const lines = textarea.value.split("\n");
        if (srcLine < 0 || srcLine >= lines.length) return;
        const removed = lines.splice(srcLine, 1)[0];
        textarea.value = lines.join("\n");
        stack.push({ index: srcLine, text: removed });
        onStackChange(stack.length);
        rerender();
      }

      function undo() {
        if (!stack.length) return;
        const last = stack.pop();
        const lines = textarea.value.split("\n");
        const at = Math.min(Math.max(last.index, 0), lines.length);
        lines.splice(at, 0, last.text);
        textarea.value = lines.join("\n");
        onStackChange(stack.length);
        rerender();
      }

      // Rebuilds every trash icon — cheap and always correct, since preview
      // is torn down and rebuilt from scratch by rerender() each time (same
      // approach verify.js's refresh() takes).
      function refresh() {
        for (const lineEl of window.PreviewLines.collect(preview)) {
          const srcLine = Number(lineEl.dataset.srcLine);
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "line-del";
          btn.title = "Delete this line";
          btn.setAttribute("aria-label", "Delete this line");
          btn.appendChild(trashIcon());
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            deleteAt(srcLine);
          });
          if (lineEl.tagName === "TR") {
            const cells = lineEl.cells;
            const lastCell = cells[cells.length - 1];
            if (lastCell) lastCell.appendChild(btn);
          } else {
            lineEl.appendChild(btn);
          }
        }
      }

      return { refresh, undo, undoCount: () => stack.length };
    }

    return { attach };
  }
);
