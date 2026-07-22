// public/preview-lines.js — shared definition of "one checkable line" in a
// rendered .summary-preview: a paragraph, a bullet item, or a table body
// row. Both linedelete.js and boilerplate.js walk the preview at this same
// granularity; this is the one place that walk is written.
(function (root, factory) {
  "use strict";
  const PL = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = PL;
  if (root) root.PreviewLines = PL;
})(
  typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null,
  function () {
    "use strict";

    function collect(preview) {
      const targets = [];
      for (const child of Array.from(preview.children)) {
        if (child.tagName === "P") {
          targets.push(child);
        } else if (child.tagName === "UL") {
          targets.push(...Array.from(child.children));
        } else if (child.tagName === "TABLE") {
          const tbody = child.tBodies[0];
          if (tbody) targets.push(...Array.from(tbody.rows));
        }
      }
      return targets;
    }

    return { collect };
  }
);
