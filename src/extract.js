// ─────────────────────────────────────────────────────────────────────────
//  EXTRACT — pull plain text out of a dropped file, entirely in the browser.
//  PDF via pdf.js, DOCX via mammoth, plain text directly.
// ─────────────────────────────────────────────────────────────────────────
window.DS = window.DS || {};

DS.extract = (function () {
  // pdf.js needs a "worker". To keep everything in one self-contained file, the
  // build inlines the worker source into a non-executing <script id="pdf-worker">
  // tag; here we turn it into a Blob URL. (No-ops during un-built dev use.)
  (function initPdfWorker() {
    if (typeof pdfjsLib === "undefined") return;
    var el = document.getElementById("pdf-worker");
    if (!el) return;
    var blob = new Blob([el.textContent], { type: "application/javascript" });
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  })();

  async function fromPdf(arrayBuffer) {
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      // SECURITY: mitigates CVE-2024-4367 (GHSA-wgrm-67xf-hhpq) — a malicious
      // PDF can otherwise execute arbitrary JS in this page, which would expose
      // the baked-in API key and the document text. We're pinned to pdf.js v3
      // for the file://-compatible UMD build, so this flag is the fix.
      isEvalSupported: false,
    }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((it) => it.str).join(" ") + "\n\n";
    }
    return text.trim();
  }

  async function fromDocx(arrayBuffer) {
    const result = await mammoth.extractRawText({ arrayBuffer });
    return (result.value || "").trim();
  }

  async function fromPlainText(file) {
    return (await file.text()).trim();
  }

  // Dispatch on file extension. Returns extracted plain text.
  async function fromFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".pdf")) return fromPdf(await file.arrayBuffer());
    if (name.endsWith(".docx")) return fromDocx(await file.arrayBuffer());
    if (name.endsWith(".txt") || name.endsWith(".md")) return fromPlainText(file);
    // TODO: scanned/image PDFs would need OCR here (use a LOCAL engine only,
    //       to stay CUI-safe — no cloud OCR).
    throw new Error(`Unsupported file type: ${file.name}`);
  }

  return { fromFile, fromPdf, fromDocx, fromPlainText };
})();
