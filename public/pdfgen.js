/*
 * pdfgen.js — hand-rolled minimal PDF generator. Zero libraries.
 *
 * Output: a valid PDF 1.4 file as a Uint8Array.
 *   - Helvetica (base-14) at 11 pt, WinAnsi encoding
 *   - US Letter pages (612 x 792 pt) with 1-inch margins
 *   - word-wrapping using real Helvetica AFM widths, automatic multi-page
 *   - backslash and parentheses escaped in text strings
 *   - characters outside Latin-1/WinAnsi replaced with '?'
 *   - xref table with correct byte offsets, trailer, startxref
 *
 * Loads in the browser as window.PDFGen (index.html includes it before
 * app.js, which uses it for the "Download PDF" button). Under Node do NOT
 * require() it — this package is "type":"module", so .js files are ESM.
 * Import it for its side effect instead, which is what the tests do:
 *
 *     import "../public/pdfgen.js";   // sets globalThis.PDFGen
 *
 * See test/pdfgen.test.mjs.
 */
(function (root) {
  "use strict";

  // --- Layout constants -------------------------------------------------
  var PAGE_W = 612; // US Letter, points
  var PAGE_H = 792;
  var MARGIN = 72; // 1 inch
  var FONT_SIZE = 11;
  var LEADING = 14; // baseline-to-baseline
  var CONTENT_W = PAGE_W - MARGIN * 2; // 468 pt of usable width

  // Standard Helvetica AFM glyph widths (1/1000 em) for char codes 32..126.
  var WIDTHS = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333,
    278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278,
    584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278,
    500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
    667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556,
    278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
    278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
  ];
  // Spot-fixes for the widest Latin-1 glyphs; everything else defaults.
  var WIDTHS_EXTRA = {
    169: 737, 171: 556, 174: 737, 187: 556, 198: 1000,
    215: 584, 230: 889, 247: 584
  };
  var DEFAULT_WIDTH = 556;

  function charWidth(code) {
    if (code >= 32 && code <= 126) return WIDTHS[code - 32];
    if (Object.prototype.hasOwnProperty.call(WIDTHS_EXTRA, code)) {
      return WIDTHS_EXTRA[code];
    }
    return DEFAULT_WIDTH;
  }

  // Width of a string in points at FONT_SIZE.
  function textWidth(str) {
    var units = 0;
    for (var i = 0; i < str.length; i++) units += charWidth(str.charCodeAt(i));
    return (units * FONT_SIZE) / 1000;
  }

  // Normalize input: unify newlines, expand tabs, and replace every
  // character that is not printable Latin-1/WinAnsi with '?'.
  function normalize(text) {
    var s = String(text == null ? "" : text)
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "    ");
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 10) out += "\n";
      else if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) out += s[i];
      else out += "?";
    }
    return out;
  }

  // Wrap one paragraph into lines that fit CONTENT_W. Empty paragraph
  // yields one empty line (a preserved blank line).
  function wrapLine(paragraph) {
    if (paragraph === "") return [""];
    var words = paragraph.split(" ");
    var lines = [];
    var cur = "";
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      var candidate = cur === "" ? word : cur + " " + word;
      if (textWidth(candidate) <= CONTENT_W) {
        cur = candidate;
        continue;
      }
      if (cur !== "") {
        lines.push(cur);
        cur = "";
      }
      // A single word wider than the content area: hard-break it.
      while (textWidth(word) > CONTENT_W) {
        var k = 1;
        while (k < word.length && textWidth(word.slice(0, k + 1)) <= CONTENT_W) k++;
        lines.push(word.slice(0, k));
        word = word.slice(k);
      }
      cur = word;
    }
    lines.push(cur);
    return lines;
  }

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

  // --- Main entry point --------------------------------------------------
  // textToPdf(text) -> Uint8Array of a complete PDF file.
  function textToPdf(text) {
    // 1. Normalize, wrap, paginate.
    var lines = [];
    var paragraphs = normalize(text).split("\n");
    for (var p = 0; p < paragraphs.length; p++) {
      var wrapped = wrapLine(paragraphs[p]);
      for (var w = 0; w < wrapped.length; w++) lines.push(wrapped[w]);
    }
    if (lines.length === 0) lines = [""];

    var usableH = PAGE_H - MARGIN * 2;
    var linesPerPage = Math.floor((usableH - FONT_SIZE) / LEADING) + 1;
    if (linesPerPage < 1) linesPerPage = 1;
    var pages = [];
    for (var i = 0; i < lines.length; i += linesPerPage) {
      pages.push(lines.slice(i, i + linesPerPage));
    }

    // 2. Build object bodies.
    // Object numbering: 1 = Catalog, 2 = Pages, 3 = Font,
    // then for page i (0-based): 4+2i = Page, 5+2i = its content stream.
    var startY = PAGE_H - MARGIN - FONT_SIZE; // first baseline
    var bodies = {}; // objNum -> body string (between "N 0 obj\n" and "\nendobj\n")
    var kids = [];
    for (var pg = 0; pg < pages.length; pg++) {
      var pageObj = 4 + pg * 2;
      var contObj = 5 + pg * 2;
      kids.push(pageObj + " 0 R");

      var ops = "BT\n/F1 " + FONT_SIZE + " Tf\n" + LEADING + " TL\n" +
        MARGIN + " " + startY + " Td\n";
      var pageLines = pages[pg];
      for (var ln = 0; ln < pageLines.length; ln++) {
        if (ln > 0) ops += "T*\n";
        ops += "(" + escapePdfString(pageLines[ln]) + ") Tj\n";
      }
      ops += "ET";

      bodies[pageObj] =
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + PAGE_W + " " + PAGE_H +
        "] /Resources << /Font << /F1 3 0 R >> >> /Contents " + contObj + " 0 R >>";
      bodies[contObj] =
        "<< /Length " + ops.length + " >>\nstream\n" + ops + "\nendstream";
    }
    bodies[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    bodies[2] = "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " +
      pages.length + " >>";
    bodies[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica " +
      "/Encoding /WinAnsiEncoding >>";

    var objCount = 3 + pages.length * 2;

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
      normalize: normalize,
      wrapLine: wrapLine,
      textWidth: textWidth,
      CONTENT_W: CONTENT_W
    }
  };

  root.PDFGen = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
