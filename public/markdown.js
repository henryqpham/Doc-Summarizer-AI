// public/markdown.js — tiny, SAFE GitHub-flavored-Markdown SUBSET parser
// shared by every consumer of model output: the formatted preview in result
// cards, the rich-text clipboard copy, the Word .doc export, and the PDF
// writer. Zero dependencies; loads in the browser (window.MD) and under
// Node (module.exports) so it can be sanity-checked with `node`.
//
// Supported blocks:
//   #..#### headings (deeper levels clamp to 4), - / * bullet lists,
//   | tables | (a header row is recognized when a |---|---| separator
//   follows; a run of | rows WITHOUT a separator still parses as a table,
//   just with no header), --- / *** / ___ horizontal rules, blank lines.
//   Every other line is its own paragraph — the weekly template depends on
//   "Week Ending: …"-style label lines staying on separate lines, so
//   consecutive text lines are deliberately NOT merged like full Markdown.
// Supported inline: **bold** only. Emoji (🟡) and arrows (↔ ↑ ↓) pass
//   through as literal text. Unmatched ** stays literal.
//
// SECURITY: summaries are untrusted model output. MD.render builds DOM
// exclusively with createElement / createTextNode / textContent — zero
// innerHTML — and MD.toHtml escapes & < > " ' in every text node before
// any string concatenation. Style strings are static constants below,
// never derived from input.
(function (root, factory) {
  "use strict";
  const MD = factory();
  // CommonJS (node --experimental or a .cjs copy); harmless in the browser.
  if (typeof module !== "undefined" && module.exports) module.exports = MD;
  // Browser: window.MD. Node ESM ("type":"module"): globalThis.MD, so a
  // sanity script can `import "./markdown.js"` and use globalThis.MD.
  if (root) root.MD = MD;
})(
  typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null,
  function () {
  "use strict";

  // ── inline parsing: **bold** + literal text ───────────────────────────
  function parseInlines(text) {
    const inlines = [];
    const re = /\*\*(.+?)\*\*/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) inlines.push({ type: "text", text: text.slice(last, m.index) });
      inlines.push({ type: "bold", text: m[1] });
      last = m.index + m[0].length;
    }
    if (last < text.length) inlines.push({ type: "text", text: text.slice(last) });
    return inlines;
  }

  // ── table helpers ─────────────────────────────────────────────────────
  // "| a | b |" -> ["a", "b"]; leading/trailing pipes optional per cellline.
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }

  // A GFM alignment row: every cell is dashes with optional colons.
  function isSeparatorCells(cells) {
    return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
  }

  // Consecutive | lines -> one table. Header only when row 2 is |---|---|.
  // sourceLines mirrors rowLines 1:1 (the raw line each row came from) and is
  // threaded through the same header/separator filtering so it stays aligned
  // with the returned `rows` — the only way the preview can map a rendered
  // <tr> back to a line in the textarea for line-delete.
  function makeTable(rowLines, sourceLines) {
    const cellRows = rowLines.map(splitRow);
    let header = null;
    let body = cellRows;
    let bodyLines = sourceLines;
    if (cellRows.length >= 2 && isSeparatorCells(cellRows[1])) {
      header = cellRows[0];
      body = cellRows.slice(2);
      bodyLines = sourceLines.slice(2);
    }
    // Tolerate stray separator rows anywhere else (models repeat them).
    const rows = [];
    const rowSourceLines = [];
    body.forEach((r, idx) => {
      if (isSeparatorCells(r)) return;
      rows.push(r);
      rowSourceLines.push(bodyLines[idx]);
    });
    return {
      type: "table",
      header: header ? header.map(parseInlines) : null,
      rows: rows.map((r) => r.map(parseInlines)),
      rowLines: rowSourceLines,
    };
  }

  // ── block parsing ─────────────────────────────────────────────────────
  // parse(text) -> array of block nodes:
  //   {type:"heading", level:1-4, inlines} | {type:"paragraph", inlines, line}
  //   {type:"list", items:[inlines], itemLines} | {type:"table", header, rows, rowLines}
  //   {type:"hr"}                          | {type:"blank"}
  // `line` / `itemLines` / `rowLines` are 0-based indexes into the input's
  // split lines — the source-of-truth mapping the preview uses to delete a
  // specific line from the raw textarea (see linedelete.js).
  function parse(text) {
    const blocks = [];
    const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();

      if (line === "") {
        blocks.push({ type: "blank" });
        i++;
        continue;
      }

      // Horizontal rule (checked before bullets so "---" is never a list).
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
        blocks.push({ type: "hr" });
        i++;
        continue;
      }

      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        blocks.push({
          type: "heading",
          level: Math.min(h[1].length, 4),
          // Strip optional closing hashes ("## Title ##").
          inlines: parseInlines(h[2].replace(/\s+#+\s*$/, "")),
        });
        i++;
        continue;
      }

      // Table: a run of lines that start with "|" (separator row optional).
      if (line.charAt(0) === "|") {
        const rows = [];
        const rowLines = [];
        while (i < lines.length && lines[i].trim().charAt(0) === "|") {
          rows.push(lines[i].trim());
          rowLines.push(i);
          i++;
        }
        blocks.push(makeTable(rows, rowLines));
        continue;
      }

      // Bullet list: consecutive "- item" / "* item" lines.
      if (/^[-*]\s+/.test(line)) {
        const items = [];
        const itemLines = [];
        while (i < lines.length) {
          const bm = /^[-*]\s+(.*)$/.exec(lines[i].trim());
          if (!bm) break;
          items.push(parseInlines(bm[1]));
          itemLines.push(i);
          i++;
        }
        blocks.push({ type: "list", items, itemLines });
        continue;
      }

      // Anything else: one paragraph per line (see file header for why).
      blocks.push({ type: "paragraph", inlines: parseInlines(line), line: i });
      i++;
    }
    return blocks;
  }

  // ── DOM rendering (browser only) ──────────────────────────────────────
  function appendInlines(el, inlines) {
    for (const inl of inlines) {
      if (inl.type === "bold") {
        const strong = document.createElement("strong");
        strong.textContent = inl.text;
        el.appendChild(strong);
      } else {
        el.appendChild(document.createTextNode(inl.text));
      }
    }
  }

  function blockToDom(block) {
    switch (block.type) {
      case "heading": {
        const h = document.createElement("h" + Math.min(Math.max(block.level, 1), 4));
        appendInlines(h, block.inlines);
        return h;
      }
      case "paragraph": {
        const p = document.createElement("p");
        appendInlines(p, block.inlines);
        p.dataset.srcLine = String(block.line);
        return p;
      }
      case "list": {
        const ul = document.createElement("ul");
        block.items.forEach((item, idx) => {
          const li = document.createElement("li");
          appendInlines(li, item);
          li.dataset.srcLine = String(block.itemLines[idx]);
          ul.appendChild(li);
        });
        return ul;
      }
      case "table": {
        const table = document.createElement("table");
        if (block.header) {
          const thead = document.createElement("thead");
          const tr = document.createElement("tr");
          for (const cell of block.header) {
            const th = document.createElement("th");
            appendInlines(th, cell);
            tr.appendChild(th);
          }
          thead.appendChild(tr);
          table.appendChild(thead);
        }
        const tbody = document.createElement("tbody");
        block.rows.forEach((row, idx) => {
          const tr = document.createElement("tr");
          tr.dataset.srcLine = String(block.rowLines[idx]);
          for (const cell of row) {
            const td = document.createElement("td");
            appendInlines(td, cell);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        return table;
      }
      case "hr":
        return document.createElement("hr");
      default:
        return null; // blank — spacing is the stylesheet's job
    }
  }

  // render(tree) -> DocumentFragment, built entirely without innerHTML.
  function render(blocks) {
    if (typeof document === "undefined") {
      throw new Error("MD.render needs a browser DOM; use MD.toHtml under Node.");
    }
    const frag = document.createDocumentFragment();
    for (const block of blocks) {
      const el = blockToDom(block);
      if (el) frag.appendChild(el);
    }
    return frag;
  }

  // ── HTML string serialization (clipboard / .doc export) ───────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function inlinesToHtml(inlines) {
    return inlines
      .map((inl) => (inl.type === "bold" ? "<strong>" + esc(inl.text) + "</strong>" : esc(inl.text)))
      .join("");
  }

  // Inline styles (STATIC constants — never from input) so Outlook's and
  // Word's engines keep the look on paste/open: pt sizes, Calibri, real
  // table borders, shaded header row. Both ignore <style> blocks reliably.
  const FONT = "font-family:Calibri,Arial,sans-serif;";
  const EXPORT_STYLES = {
    h1: FONT + "font-size:17pt;font-weight:bold;margin:14pt 0 4pt 0;",
    h2: FONT + "font-size:14pt;font-weight:bold;margin:12pt 0 3pt 0;",
    h3: FONT + "font-size:12pt;font-weight:bold;margin:10pt 0 2pt 0;",
    h4: FONT + "font-size:11pt;font-weight:bold;margin:8pt 0 2pt 0;",
    p: FONT + "font-size:11pt;margin:4pt 0;",
    ul: "margin:4pt 0 8pt 0;padding-left:24pt;",
    li: FONT + "font-size:11pt;margin:2pt 0;",
    hr: "border:none;border-top:1.5pt solid #7f7f7f;margin:10pt 0;",
    table: "border-collapse:collapse;margin:6pt 0 10pt 0;",
    th: FONT + "font-size:10.5pt;font-weight:bold;border:1pt solid #7f7f7f;padding:3pt 8pt;background:#f2f2f2;text-align:left;",
    td: FONT + "font-size:10.5pt;border:1pt solid #7f7f7f;padding:3pt 8pt;vertical-align:top;",
  };

  // toHtml(tree) -> HTML STRING with every text node escaped. Built from
  // the parsed tree only — raw input never reaches the output directly.
  function toHtml(blocks) {
    const out = [];
    for (const block of blocks) {
      switch (block.type) {
        case "heading": {
          const t = "h" + Math.min(Math.max(block.level, 1), 4);
          out.push("<" + t + ' style="' + EXPORT_STYLES[t] + '">' + inlinesToHtml(block.inlines) + "</" + t + ">");
          break;
        }
        case "paragraph":
          out.push('<p style="' + EXPORT_STYLES.p + '">' + inlinesToHtml(block.inlines) + "</p>");
          break;
        case "list": {
          const items = block.items
            .map((it) => '<li style="' + EXPORT_STYLES.li + '">' + inlinesToHtml(it) + "</li>")
            .join("");
          out.push('<ul style="' + EXPORT_STYLES.ul + '">' + items + "</ul>");
          break;
        }
        case "table": {
          let html = '<table style="' + EXPORT_STYLES.table + '">';
          if (block.header) {
            html +=
              "<thead><tr>" +
              block.header.map((c) => '<th style="' + EXPORT_STYLES.th + '">' + inlinesToHtml(c) + "</th>").join("") +
              "</tr></thead>";
          }
          html +=
            "<tbody>" +
            block.rows
              .map((row) => "<tr>" + row.map((c) => '<td style="' + EXPORT_STYLES.td + '">' + inlinesToHtml(c) + "</td>").join("") + "</tr>")
              .join("") +
            "</tbody></table>";
          out.push(html);
          break;
        }
        case "hr":
          out.push('<hr style="' + EXPORT_STYLES.hr + '">');
          break;
        // blank: export margins already provide the spacing
      }
    }
    return out.join("\n");
  }

  return { parse, render, toHtml };
});
