/*
 * pdfgen.js — hand-rolled minimal, markdown-aware PDF generator. Zero
 * libraries.
 *
 * Entry (unchanged): PDFGen.textToPdf(text) -> Uint8Array of a PDF file.
 * The text is the same GitHub-flavored-Markdown subset the rest of the app
 * uses: textToPdf parses it internally with MD.parse (public/markdown.js,
 * loaded separately as window.MD / globalThis.MD) and lays the tree out
 * with real report styling:
 *
 *   - headings: h1 17pt / h2 14pt / h3 12pt / h4 11pt, Helvetica-Bold
 *   - paragraphs 10.5pt Helvetica; **bold** runs switch to Helvetica-Bold
 *   - bullet lists: indented, real WinAnsi bullet glyph (char 149)
 *   - --- rules: thin full-width horizontal line
 *   - | tables |: ruled grid, shaded bold header row (repeated after a
 *     page break), column widths measured from the text; when natural
 *     widths exceed the page the wide columns shrink proportionally and
 *     cell text WRAPS onto extra lines (single overlong words hard-break);
 *     nothing is truncated
 *   - US Letter pages (612 x 792 pt), 1-inch margins, automatic multi-page
 *   - Helvetica + Helvetica-Bold (base-14) with WinAnsiEncoding; known
 *     template glyphs map to WinAnsi-safe stand-ins first (🟡→(Y) 🟢→(G)
 *     🔴→(R) 🟠→(O), ↔→<->, ↑→^, ↓→v, smart quotes/dashes/ellipsis to
 *     ASCII), then anything still outside WinAnsi becomes '?'
 *   - xref table with correct byte offsets, trailer, startxref
 *
 * If MD is not loaded the text falls back to plain paragraphs, so
 * textToPdf never throws just because markdown.js is missing.
 *
 * Loads in the browser as window.PDFGen (index.html includes it alongside
 * markdown.js, before app.js). Under Node do NOT require() it — this
 * package is "type":"module", so .js files are ESM. Import both files for
 * their side effects instead:
 *
 *     import "../public/markdown.js"; // sets globalThis.MD
 *     import "../public/pdfgen.js";   // sets globalThis.PDFGen
 */
(function (root) {
  "use strict";

  // --- Layout constants -------------------------------------------------
  var PAGE_W = 612; // US Letter, points
  var PAGE_H = 792;
  var MARGIN = 72; // 1 inch
  var CONTENT_W = PAGE_W - MARGIN * 2; // 468 pt of usable width

  // Body text
  var BODY_SIZE = 10.5;
  var BODY_LEAD = 14;

  // Headings by level: font size, leading, space before/after (points).
  var HEAD = {
    1: { size: 17, lead: 21, before: 12, after: 5 },
    2: { size: 14, lead: 18, before: 10, after: 4 },
    3: { size: 12, lead: 15.5, before: 8, after: 3 },
    4: { size: 11, lead: 14, before: 7, after: 2 }
  };

  // Lists
  var LIST_INDENT = 16; // text x offset from margin
  var BULLET_X = 5; // bullet x offset from margin
  var BULLET = String.fromCharCode(149); // WinAnsi bullet glyph

  // Tables
  var T_SIZE = 10; // cell font size
  var T_LEAD = 12.5; // cell line leading
  var T_PADH = 5; // horizontal cell padding
  var T_PADV = 3; // vertical cell padding
  var T_MIN_COL = 30; // minimum column content width after shrinking
  var T_ASCENT = T_SIZE * 0.75; // first-baseline drop inside a cell

  // --- Font metrics -----------------------------------------------------
  // Standard AFM glyph widths (1/1000 em) for char codes 32..126.
  var WIDTHS = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333,
    278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278,
    584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278,
    500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
    667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556,
    278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
    278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
  ];
  var WIDTHS_BOLD = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333,
    278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333,
    584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278,
    556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
    667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556,
    333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556,
    333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584
  ];
  // Spot-fixes for the widest Latin-1 glyphs plus the bullet (code 149);
  // everything else defaults.
  var WIDTHS_EXTRA = {
    149: 350, 169: 737, 171: 556, 174: 737, 187: 556, 198: 1000,
    215: 584, 230: 889, 247: 584
  };
  var WIDTHS_BOLD_EXTRA = {
    149: 350, 169: 737, 171: 556, 174: 737, 187: 556, 198: 1000,
    215: 584, 230: 889, 247: 584
  };
  var DEFAULT_WIDTH = 556;
  var DEFAULT_WIDTH_BOLD = 611;

  function charWidth(code, bold) {
    if (code >= 32 && code <= 126) {
      return (bold ? WIDTHS_BOLD : WIDTHS)[code - 32];
    }
    var extra = bold ? WIDTHS_BOLD_EXTRA : WIDTHS_EXTRA;
    if (Object.prototype.hasOwnProperty.call(extra, code)) return extra[code];
    return bold ? DEFAULT_WIDTH_BOLD : DEFAULT_WIDTH;
  }

  // Width of a string in points at `size` in regular or bold Helvetica.
  function textWidth(str, bold, size) {
    var units = 0;
    for (var i = 0; i < str.length; i++) units += charWidth(str.charCodeAt(i), bold);
    return (units * size) / 1000;
  }

  // --- Character sanitizing ---------------------------------------------
  // Known glyphs from the weekly template mapped to WinAnsi-safe stand-ins.
  var GLYPHS = {
    "🟡": "(Y)", // 🟡
    "🟢": "(G)", // 🟢
    "🔴": "(R)", // 🔴
    "🟠": "(O)", // 🟠
    "↔": "<->", // ↔
    "↑": "^", // ↑
    "↓": "v", // ↓
    "⬆": "^", // ⬆
    "⬇": "v", // ⬇
    "→": "->", // →
    "←": "<-", // ←
    "–": "-", // en dash
    "—": "--", // em dash
    "‘": "'", // ‘
    "’": "'", // ’
    "“": '"', // “
    "”": '"', // ”
    "…": "...", // …
    "•": BULLET, // • -> real WinAnsi bullet
    "️": "", // emoji variation selector — drop
    "​": "", // zero-width space — drop
    "‍": "" // zero-width joiner — drop
  };

  // Replace mapped glyphs, keep printable WinAnsi, everything else -> '?'.
  // Iterates by code POINT so an unmapped emoji becomes one '?', not two.
  function sanitize(str) {
    var out = "";
    var s = String(str == null ? "" : str);
    for (var ch of s) {
      if (Object.prototype.hasOwnProperty.call(GLYPHS, ch)) {
        out += GLYPHS[ch];
        continue;
      }
      var c = ch.codePointAt(0);
      if (c === 9) out += "    ";
      else if (c === 10 || c === 13) out += " ";
      else if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255) || c === 149) out += ch;
      else out += "?";
    }
    return out;
  }

  // --- Inline runs -> word tokens ---------------------------------------
  // MD inlines [{type:"text"|"bold", text}] -> [{text, bold, glue}].
  // glue=true means "attach to the previous token with no space" (a bold
  // boundary in the middle of a word).
  function tokenize(inlines) {
    var tokens = [];
    var prevEndsSpace = true; // first token never glues
    for (var r = 0; r < inlines.length; r++) {
      var bold = inlines[r].type === "bold";
      var text = sanitize(inlines[r].text);
      if (text === "") continue;
      var startsSpace = text.charAt(0) === " ";
      var endsSpace = text.charAt(text.length - 1) === " ";
      var parts = text.split(" ");
      var first = true;
      for (var p = 0; p < parts.length; p++) {
        if (parts[p] === "") continue;
        var glue = first && !startsSpace && !prevEndsSpace && tokens.length > 0;
        first = false;
        tokens.push({ text: parts[p], bold: bold, glue: glue });
      }
      prevEndsSpace = endsSpace;
    }
    return tokens;
  }

  function boldTokens(tokens) {
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      out.push({ text: tokens[i].text, bold: true, glue: tokens[i].glue });
    }
    return out;
  }

  function spaceW(bold, size) {
    return (charWidth(32, bold) * size) / 1000;
  }

  // Width of tokens laid out on a single line (used for table columns).
  function tokensWidth(tokens, size) {
    var w = 0;
    for (var i = 0; i < tokens.length; i++) {
      if (i > 0 && !tokens[i].glue) w += spaceW(tokens[i].bold, size);
      w += textWidth(tokens[i].text, tokens[i].bold, size);
    }
    return w;
  }

  // Wrap tokens into lines that fit maxW. A single token wider than maxW
  // hard-breaks (same policy as the old plain-text writer). Always returns
  // at least one (possibly empty) line.
  function wrapTokens(tokens, maxW, size) {
    var lines = [];
    var line = [];
    var lineW = 0;
    for (var i = 0; i < tokens.length; i++) {
      var t = { text: tokens[i].text, bold: tokens[i].bold, glue: tokens[i].glue };
      var w = textWidth(t.text, t.bold, size);
      var sep = line.length === 0 || t.glue ? 0 : spaceW(t.bold, size);
      if (line.length > 0 && lineW + sep + w > maxW) {
        lines.push(line);
        line = [];
        lineW = 0;
        t.glue = false;
      }
      while (line.length === 0 && w > maxW && t.text.length > 1) {
        var k = 1;
        while (k < t.text.length && textWidth(t.text.slice(0, k + 1), t.bold, size) <= maxW) k++;
        lines.push([{ text: t.text.slice(0, k), bold: t.bold, glue: false }]);
        t.text = t.text.slice(k);
        w = textWidth(t.text, t.bold, size);
      }
      if (line.length === 0) {
        t.glue = false;
        line.push(t);
        lineW = w;
      } else {
        line.push(t);
        lineW += (t.glue ? 0 : spaceW(t.bold, size)) + w;
      }
    }
    if (line.length > 0) lines.push(line);
    if (lines.length === 0) lines.push([]);
    return lines;
  }

  // Merge one wrapped line's tokens into same-font segments. The joining
  // space is carried at the START of the incoming token's segment, matching
  // how wrapTokens measured it.
  function lineSegs(line) {
    var segs = [];
    for (var i = 0; i < line.length; i++) {
      var t = line[i];
      var sep = i === 0 || t.glue ? "" : " ";
      if (segs.length > 0 && segs[segs.length - 1].bold === t.bold) {
        segs[segs.length - 1].text += sep + t.text;
      } else {
        segs.push({ bold: t.bold, text: sep + t.text });
      }
    }
    return segs;
  }

  // --- PDF string helpers -----------------------------------------------
  // Escape backslash and parentheses for a PDF literal string.
  function escapePdfString(str) {
    return str.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  }

  // Encode a JS string (all char codes <= 255) into bytes, one byte each.
  function latin1Bytes(str) {
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    return bytes;
  }

  function pad10(n) {
    var s = String(n);
    while (s.length < 10) s = "0" + s;
    return s;
  }

  // Coordinates rounded to 2 decimals; String() of the rounded float never
  // produces an exponent at page magnitudes.
  function num(v) {
    return String(Math.round(v * 100) / 100);
  }

  // --- Page state --------------------------------------------------------
  // state.y is the TOP of the next line; a line of `lead` pts occupies
  // [y-lead, y] with its baseline at y - fontSize.
  function newPage(state) {
    state.ops = [];
    state.pages.push(state.ops);
    state.y = PAGE_H - MARGIN;
    state.atTop = true;
  }

  // Reserve h points of vertical space; page-break first if it cannot fit.
  function need(state, h) {
    if (state.y - h < MARGIN) newPage(state);
  }

  // Vertical whitespace, skipped at the top of a page.
  function gap(state, h) {
    if (!state.atTop) state.y -= h;
  }

  function emitSegs(state, segs, x, base, size) {
    var xx = x;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.text !== "") {
        state.ops.push(
          "BT /" + (s.bold ? "F2" : "F1") + " " + num(size) + " Tf " +
          num(xx) + " " + num(base) + " Td (" + escapePdfString(s.text) + ") Tj ET"
        );
      }
      xx += textWidth(s.text, s.bold, size);
    }
  }

  // Wrap tokens and draw them. opts: {x, maxW, size, lead, bulletX, keep}.
  // keep = extra space required with the FIRST line, so headings never
  // strand at the bottom of a page.
  function drawWrapped(state, tokens, opts) {
    var lines = wrapTokens(tokens, opts.maxW, opts.size);
    for (var i = 0; i < lines.length; i++) {
      need(state, opts.lead + (i === 0 && opts.keep ? opts.keep : 0));
      var base = state.y - opts.size;
      if (i === 0 && opts.bulletX != null) {
        state.ops.push(
          "BT /F1 " + num(opts.size) + " Tf " + num(opts.bulletX) + " " +
          num(base) + " Td (" + BULLET + ") Tj ET"
        );
      }
      emitSegs(state, lineSegs(lines[i]), opts.x, base, opts.size);
      state.y -= opts.lead;
      state.atTop = false;
    }
  }

  // --- Tables -------------------------------------------------------------
  function drawTable(state, block) {
    var headerCells = block.header
      ? block.header.map(function (c) { return boldTokens(tokenize(c)); })
      : null;
    var bodyCells = block.rows.map(function (r) { return r.map(tokenize); });

    var nCols = headerCells ? headerCells.length : 0;
    for (var i = 0; i < bodyCells.length; i++) {
      if (bodyCells[i].length > nCols) nCols = bodyCells[i].length;
    }
    if (nCols === 0) return;

    // Natural (single-line) content width per column.
    var natural = [];
    for (var c = 0; c < nCols; c++) natural.push(0);
    var consider = function (cells) {
      for (var cc = 0; cc < nCols; cc++) {
        var w = tokensWidth(cells[cc] || [], T_SIZE);
        if (w > natural[cc]) natural[cc] = w;
      }
    };
    if (headerCells) consider(headerCells);
    for (i = 0; i < bodyCells.length; i++) consider(bodyCells[i]);

    // Column sizing: natural widths when they fit; otherwise columns that
    // are narrower than an equal share keep their natural width and the
    // remaining width is split among the wide columns in proportion to
    // their natural widths. Cell text then WRAPS inside its column.
    var availContent = CONTENT_W - nCols * 2 * T_PADH;
    var widths = natural.slice();
    var total = 0;
    for (c = 0; c < nCols; c++) total += natural[c];
    if (total > availContent) {
      var flex = [];
      for (c = 0; c < nCols; c++) flex.push(c);
      var remaining = availContent;
      var changed = true;
      while (changed && flex.length > 0) {
        changed = false;
        var share = remaining / flex.length;
        for (var f = flex.length - 1; f >= 0; f--) {
          if (natural[flex[f]] <= share) {
            widths[flex[f]] = natural[flex[f]];
            remaining -= natural[flex[f]];
            flex.splice(f, 1);
            changed = true;
          }
        }
      }
      if (flex.length > 0) {
        var flexTotal = 0;
        for (f = 0; f < flex.length; f++) flexTotal += natural[flex[f]];
        for (f = 0; f < flex.length; f++) {
          widths[flex[f]] = Math.max(T_MIN_COL, (remaining * natural[flex[f]]) / flexTotal);
        }
      }
    }

    var xs = [MARGIN];
    for (c = 0; c < nCols; c++) xs.push(xs[c] + widths[c] + 2 * T_PADH);
    var tableW = xs[nCols] - xs[0];

    // Pre-wrap every row once.
    var layoutRow = function (cells, isHeader) {
      var lines = [];
      var maxLines = 1;
      for (var cc = 0; cc < nCols; cc++) {
        var cl = wrapTokens(cells[cc] || [], widths[cc], T_SIZE);
        lines.push(cl);
        if (cl.length > maxLines) maxLines = cl.length;
      }
      return { lines: lines, rowH: maxLines * T_LEAD + 2 * T_PADV, isHeader: isHeader };
    };
    var headerRow = headerCells ? layoutRow(headerCells, true) : null;
    var rows = [];
    for (i = 0; i < bodyCells.length; i++) rows.push(layoutRow(bodyCells[i], false));

    // Every row is drawn with its own full border (shared edges overdraw
    // invisibly) so a page break between rows still leaves both fragments
    // fully ruled.
    var emitRow = function (row) {
      var top = state.y;
      var bot = top - row.rowH;
      if (row.isHeader) {
        state.ops.push(
          "0.94 g " + num(xs[0]) + " " + num(bot) + " " + num(tableW) + " " +
          num(row.rowH) + " re f 0 g"
        );
      }
      var strokes = "0.5 w 0.55 G\n" +
        num(xs[0]) + " " + num(top) + " m " + num(xs[nCols]) + " " + num(top) + " l S\n" +
        num(xs[0]) + " " + num(bot) + " m " + num(xs[nCols]) + " " + num(bot) + " l S";
      for (var cc = 0; cc <= nCols; cc++) {
        strokes += "\n" + num(xs[cc]) + " " + num(top) + " m " + num(xs[cc]) + " " + num(bot) + " l S";
      }
      state.ops.push(strokes + "\n0 G");
      for (cc = 0; cc < nCols; cc++) {
        var cellLines = row.lines[cc];
        for (var j = 0; j < cellLines.length; j++) {
          var base = top - T_PADV - T_ASCENT - j * T_LEAD;
          emitSegs(state, lineSegs(cellLines[j]), xs[cc] + T_PADH, base, T_SIZE);
        }
      }
      state.y = bot;
      state.atTop = false;
    };

    gap(state, 5);
    if (headerRow) {
      // Keep the header attached to the first body row.
      var keepH = headerRow.rowH + (rows.length > 0 ? rows[0].rowH : 0);
      if (state.y - keepH < MARGIN) newPage(state);
      emitRow(headerRow);
    }
    for (i = 0; i < rows.length; i++) {
      if (state.y - rows[i].rowH < MARGIN) {
        newPage(state);
        if (headerRow) emitRow(headerRow); // repeat header on the new page
      }
      emitRow(rows[i]);
    }
    state.y -= 6;
  }

  // --- Fallback when markdown.js is not loaded ---------------------------
  function fallbackParse(text) {
    var lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
    var blocks = [];
    for (var i = 0; i < lines.length; i++) {
      blocks.push(
        lines[i].trim() === ""
          ? { type: "blank" }
          : { type: "paragraph", inlines: [{ type: "text", text: lines[i] }] }
      );
    }
    return blocks;
  }

  // --- Main entry point --------------------------------------------------
  // textToPdf(text) -> Uint8Array of a complete PDF file. `text` is
  // Markdown; it is parsed and laid out here.
  function textToPdf(text) {
    var MD = root.MD;
    var blocks = MD && typeof MD.parse === "function" ? MD.parse(text) : fallbackParse(text);

    // 1. Lay every block out into per-page content-stream ops.
    var state = { pages: [], ops: null, y: 0, atTop: true };
    newPage(state);

    for (var b = 0; b < blocks.length; b++) {
      var blk = blocks[b];
      switch (blk.type) {
        case "heading": {
          var lvl = Math.min(Math.max(blk.level || 1, 1), 4);
          var st = HEAD[lvl];
          gap(state, st.before);
          drawWrapped(state, boldTokens(tokenize(blk.inlines)), {
            x: MARGIN, maxW: CONTENT_W, size: st.size, lead: st.lead, keep: 12
          });
          state.y -= st.after;
          break;
        }
        case "paragraph":
          drawWrapped(state, tokenize(blk.inlines), {
            x: MARGIN, maxW: CONTENT_W, size: BODY_SIZE, lead: BODY_LEAD
          });
          state.y -= 2;
          break;
        case "list":
          gap(state, 2);
          for (var li = 0; li < blk.items.length; li++) {
            drawWrapped(state, tokenize(blk.items[li]), {
              x: MARGIN + LIST_INDENT, maxW: CONTENT_W - LIST_INDENT,
              size: BODY_SIZE, lead: BODY_LEAD, bulletX: MARGIN + BULLET_X
            });
          }
          state.y -= 3;
          break;
        case "table":
          drawTable(state, blk);
          break;
        case "hr":
          gap(state, 6);
          need(state, 10);
          state.ops.push(
            "0.9 w 0.5 G " + MARGIN + " " + num(state.y - 3) + " m " +
            (PAGE_W - MARGIN) + " " + num(state.y - 3) + " l S 0 G"
          );
          state.y -= 10;
          state.atTop = false;
          break;
        case "blank":
          gap(state, 4);
          break;
      }
    }

    // Drop empty trailing pages, but always emit at least one page.
    var pages = state.pages.filter(function (p) { return p.length > 0; });
    if (pages.length === 0) pages = [[]];

    // 2. Build object bodies.
    // Object numbering: 1 = Catalog, 2 = Pages, 3 = Helvetica (F1),
    // 4 = Helvetica-Bold (F2), then for page i (0-based):
    // 5+2i = Page, 6+2i = its content stream.
    var bodies = {};
    var kids = [];
    for (var pg = 0; pg < pages.length; pg++) {
      var pageObj = 5 + pg * 2;
      var contObj = 6 + pg * 2;
      kids.push(pageObj + " 0 R");
      var stream = pages[pg].join("\n");
      bodies[pageObj] =
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + PAGE_W + " " + PAGE_H +
        "] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents " +
        contObj + " 0 R >>";
      bodies[contObj] =
        "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream";
    }
    bodies[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    bodies[2] = "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " +
      pages.length + " >>";
    bodies[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica " +
      "/Encoding /WinAnsiEncoding >>";
    bodies[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold " +
      "/Encoding /WinAnsiEncoding >>";

    var objCount = 4 + pages.length * 2;

    // 3. Serialize with byte-accurate offsets. Every char in every part is
    // <= 0xFF, so JS string length equals byte length.
    var out = "";
    out += "%PDF-1.4\n%" + String.fromCharCode(226, 227, 207, 211) + "\n";

    var offsets = new Array(objCount + 1);
    for (var n = 1; n <= objCount; n++) {
      offsets[n] = out.length;
      out += n + " 0 obj\n" + bodies[n] + "\nendobj\n";
    }

    var xrefPos = out.length;
    out += "xref\n0 " + (objCount + 1) + "\n";
    out += "0000000000 65535 f \n";
    for (n = 1; n <= objCount; n++) {
      out += pad10(offsets[n]) + " 00000 n \n";
    }
    out += "trailer\n<< /Size " + (objCount + 1) + " /Root 1 0 R >>\n" +
      "startxref\n" + xrefPos + "\n%%EOF\n";

    return latin1Bytes(out);
  }

  var api = {
    textToPdf: textToPdf,
    // exposed for tests
    _internal: {
      sanitize: sanitize,
      tokenize: tokenize,
      wrapTokens: wrapTokens,
      textWidth: textWidth,
      CONTENT_W: CONTENT_W
    }
  };

  root.PDFGen = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
