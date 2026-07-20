// Front-end: drop one or more files -> each is text-extracted via the local
// server (POST /api/extract, strictly one upload in flight at a time) -> then
// either ONE combined summary or one summary per file (POST /api/summarize-text,
// also strictly sequential). Files never go anywhere except 127.0.0.1; the
// local server forwards them.
// All state lives in memory only — nothing is ever persisted in the browser.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // ── inline SVG icons (built with createElementNS — never innerHTML) ────
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICON_FILE = [
    "M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z",
    "M14 2v5h5",
  ];
  const ICON_DOC = ICON_FILE.concat("M9 13h6M9 17h6");
  const ICON_COMBINED = [
    "M8 4h9a2 2 0 0 1 2 2v12",
    "M12 8H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V12z",
  ];
  const ICON_COPY = [
    "M11 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z",
    "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  ];
  const ICON_CHECK = [
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
    "m8.5 12.2 2.4 2.4 4.6-5",
  ];
  const ICON_WARN = [
    "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
    "M12 9v4M12 17h.01",
  ];

  function svgIcon(paths, size) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(size || 17));
    svg.setAttribute("height", String(size || 17));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }

  function spinnerEl() {
    const s = document.createElement("span");
    s.className = "spinner";
    s.setAttribute("aria-hidden", "true");
    return s;
  }

  // File-type tint for the row icon square, by extension.
  function fileTypeClass(name) {
    const m = /\.([^.]+)$/.exec(name || "");
    const ext = m ? m[1].toLowerCase() : "";
    if (ext === "pdf") return "pdf";
    if (["doc", "docx", "txt", "md", "rtf"].includes(ext)) return "doc";
    return "misc";
  }

  // "412 KB" / "1.4 MB" style sizes for the file rows.
  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  // ── limits & pre-flight ───────────────────────────────────────────────
  // Mirrors the server's upload cap (config.maxUploadBytes) so an oversized
  // file fails instantly instead of after a doomed 25 MB upload.
  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
  // Extensions Ask Sage extraction is known to handle. Anything else gets a
  // soft warning on its row but is still allowed through.
  const KNOWN_EXTENSIONS = new Set([
    "pdf", "docx", "doc", "txt", "md", "rtf",
    "pptx", "xlsx", "csv", "png", "jpg", "jpeg", "tif", "tiff",
  ]);

  // ── request timeouts ──────────────────────────────────────────────────
  const LONG_TIMEOUT_MS = 6 * 60 * 1000; // extract & summarize
  const HEALTH_TIMEOUT_MS = 5 * 1000;
  const TIMEOUT_MESSAGE = "Timed out after 6 minutes — try a smaller document or try again.";

  // fetch() with an AbortController deadline. On timeout the caller gets a
  // friendly Error instead of a raw AbortError.
  async function fetchWithTimeout(url, options, ms, timeoutMessage) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } catch (err) {
      if (controller.signal.aborted) throw new Error(timeoutMessage);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── state (memory only) ───────────────────────────────────────────────
  // { file, name, status: "queued"|"extracting"|"ready"|"error",
  //   text, chars, error, warn, noRetry }
  const queue = [];
  let summarizing = false;
  let extractingNow = false; // one /api/extract in flight at a time
  let activeTab = "summaries"; // "summaries" | "compare"

  // Download names follow the weekly-report convention: name_report_7_20_2026.pdf
  function reportDate() {
    const d = new Date();
    return `${d.getMonth() + 1}_${d.getDate()}_${d.getFullYear()}`;
  }

  // Tinted status line in the right pane: spinner while busy, check when ok,
  // warning triangle on error. Text always lands via createTextNode.
  function setStatus(msg, kind) {
    const el = $("status");
    el.textContent = ""; // drop previous icon + text
    el.className = "statusline" + (kind ? " statusline--" + kind : "");
    el.hidden = !msg;
    if (!msg) return;
    if (kind === "busy") el.appendChild(spinnerEl());
    else if (kind === "error") el.appendChild(svgIcon(ICON_WARN, 15));
    else el.appendChild(svgIcon(ICON_CHECK, 15));
    el.appendChild(document.createTextNode(msg));
  }

  // ── health banner + healthy-state model line ──────────────────────────
  // The server's /api/health reports which model is configured and whether it
  // is a government ("-gov") endpoint. Warn BEFORE anything is uploaded: a
  // commercial model would make sending CUI a spill, and a dead server would
  // otherwise only surface as a raw "Failed to fetch" after a drop.
  // Red banner under the app bar; icon + text rebuilt on every call.
  function showBanner(msg) {
    const banner = $("banner");
    banner.textContent = "";
    banner.append(svgIcon(ICON_WARN, 16), document.createTextNode(msg));
    banner.hidden = false;
  }

  async function checkHealth() {
    const banner = $("banner");
    const info = $("modelinfo");
    try {
      const res = await fetchWithTimeout(
        "/api/health", {}, HEALTH_TIMEOUT_MS,
        "Health check timed out after 5 seconds."
      );
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error();
      if (!data.gov) {
        showBanner(
          `Warning: the configured model "${data.model}" does not end in "-gov" — it is not a ` +
            `government endpoint. Do not upload CUI. Fix ASKSAGE_MODEL in .env and restart.`
        );
        info.hidden = true;
      } else {
        banner.hidden = true;
        // Quiet confirmation in the app bar: model name + a green GOV pill.
        info.textContent = "";
        const label = document.createElement("span");
        label.className = "model-name";
        label.textContent = data.model;
        const badge = document.createElement("span");
        badge.className = "pill pill-green";
        badge.textContent = "GOV";
        info.append(label, badge);
        info.hidden = false;
      }
    } catch {
      showBanner(
        "Can't reach the local server. It may have been closed — start it again (npm start), then reload this page."
      );
      info.hidden = true;
    }
  }

  // ── summary mode ──────────────────────────────────────────────────────
  function currentMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : "combined";
  }

  function setModeDisabled(disabled) {
    document.querySelectorAll('input[name="mode"]').forEach((r) => {
      r.disabled = disabled;
    });
  }

  // ── file queue ────────────────────────────────────────────────────────
  function smallButton(label, onClick, className) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className || "btn-ghost";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  // A tinted status pill for a file row. `withSpinner`/`withCheck` prepend the
  // matching glyph; text always lands via createTextNode.
  function statusPill(kind, text, { withSpinner = false, withCheck = false } = {}) {
    const pill = document.createElement("span");
    pill.className = "pill pill-" + kind;
    if (withSpinner) pill.appendChild(spinnerEl());
    if (withCheck) pill.appendChild(svgIcon(ICON_CHECK, 12));
    pill.appendChild(document.createTextNode(text));
    return pill;
  }

  function render() {
    const list = $("filelist");
    list.textContent = ""; // rebuild; textContent everywhere — never innerHTML with filenames
    for (const item of queue) {
      const li = document.createElement("li");
      li.className = "file-row" + (item.status === "queued" ? " is-muted" : "");

      // Tinted file-type icon square (red pdf / indigo doc / slate misc).
      const type = fileTypeClass(item.name);
      const ftype = document.createElement("div");
      ftype.className = "ftype ftype-" + type;
      ftype.appendChild(svgIcon(type === "doc" ? ICON_DOC : ICON_FILE));

      const main = document.createElement("div");
      main.className = "file-main";

      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = item.name;

      const meta = document.createElement("div");
      meta.className = "file-meta";
      const size = document.createElement("span");
      size.textContent = formatSize(item.file && item.file.size);
      meta.appendChild(size);
      if (item.status === "queued") {
        meta.appendChild(statusPill("muted", "Queued…"));
      } else if (item.status === "extracting") {
        meta.appendChild(statusPill("amber", "Extracting…", { withSpinner: true }));
      } else if (item.status === "ready") {
        // The canary: a suspiciously small number here is the tell that
        // extraction silently failed. Keep it visible.
        meta.appendChild(statusPill("green", `${item.chars.toLocaleString()} characters read`, { withCheck: true }));
      } else {
        meta.appendChild(statusPill("red", item.error));
      }
      if (item.warn && item.status !== "error") {
        // Soft amber note: unusual extension — allowed, but extraction may fail.
        meta.appendChild(statusPill("amber", "unusual file type"));
      }
      main.append(name, meta);

      const actions = document.createElement("div");
      actions.className = "file-actions";
      if (item.status === "error" && !item.noRetry) {
        actions.appendChild(smallButton("Retry", () => {
          item.status = "queued";
          item.error = "";
          render();
          pumpExtract();
        }));
      }
      actions.appendChild(
        smallButton("Remove", () => {
          queue.splice(queue.indexOf(item), 1);
          render();
        })
      );

      li.append(ftype, main, actions);
      list.appendChild(li);
    }
    $("queue").hidden = queue.length === 0;
    $("filecount").textContent = queue.length ? `${queue.length} added` : "";
    updateSummarizeButton();
  }

  function updateSummarizeButton() {
    const btn = $("summarize");
    const ready = queue.filter((f) => f.status === "ready").length;
    const pending = queue.some((f) => f.status === "queued" || f.status === "extracting");
    btn.disabled = summarizing || pending || ready === 0;
    // Only the label span — writing btn.textContent would wipe the sparkle icon.
    $("summarize-label").textContent = summarizing
      ? "Summarizing…"
      : pending
        ? "Extracting…"
        : ready > 1
          ? currentMode() === "separate"
            ? `Summarize ${ready} documents separately`
            : `Summarize ${ready} documents together`
          : "Summarize";
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    for (const file of files) {
      const name = file.name || "document";
      const item = {
        file, name, status: "queued", text: "", chars: 0,
        error: "", warn: false, noRetry: false,
      };
      // Pre-flight: reject obviously-doomed files before any bytes move.
      if (file.size === 0) {
        item.status = "error";
        item.error = "Empty file — nothing to upload.";
        item.noRetry = true;
      } else if (file.size > MAX_UPLOAD_BYTES) {
        item.status = "error";
        item.error = "Over the 25 MB limit — not uploaded. Try a smaller file.";
        item.noRetry = true;
      } else {
        const m = /\.([^.]+)$/.exec(name);
        const ext = m ? m[1].toLowerCase() : "";
        if (!KNOWN_EXTENSIONS.has(ext)) item.warn = true;
      }
      queue.push(item);
    }
    render();
    pumpExtract();
  }

  // Sequential extraction: exactly one /api/extract in flight at a time —
  // queued files wait their turn instead of hammering Ask Sage concurrently.
  async function pumpExtract() {
    if (extractingNow) return;
    const item = queue.find((f) => f.status === "queued");
    if (!item) return;
    extractingNow = true;
    try {
      await extractOne(item);
    } finally {
      extractingNow = false;
    }
    pumpExtract(); // next in line
  }

  async function extractOne(item) {
    item.status = "extracting";
    item.error = "";
    render();
    try {
      const res = await fetchWithTimeout(
        "/api/extract",
        {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-filename": encodeURIComponent(item.name),
          },
          body: item.file,
        },
        LONG_TIMEOUT_MS,
        TIMEOUT_MESSAGE
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (!queue.includes(item)) return; // removed while in flight
      item.status = "ready";
      item.text = data.text;
      item.chars = data.chars;
    } catch (err) {
      if (!queue.includes(item)) return;
      item.status = "error";
      item.error = err.message || String(err);
    }
    render();
  }

  // ── summarize ─────────────────────────────────────────────────────────
  async function requestSummary(docs) {
    const res = await fetchWithTimeout(
      "/api/summarize-text",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          documents: docs.map((f) => ({ filename: f.name, text: f.text })),
        }),
      },
      LONG_TIMEOUT_MS,
      TIMEOUT_MESSAGE
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function summarize() {
    const ready = queue.filter((f) => f.status === "ready");
    if (!ready.length || summarizing) return;
    summarizing = true;
    setModeDisabled(true);
    updateSummarizeButton();
    try {
      if (currentMode() === "separate") await summarizeSeparately(ready);
      else await summarizeCombined(ready);
    } finally {
      summarizing = false;
      setModeDisabled(false);
      updateSummarizeButton();
    }
  }

  // All ready documents -> ONE combined summary -> one card.
  async function summarizeCombined(ready) {
    setStatus(
      ready.length === 1
        ? `Summarizing "${ready[0].name}"… this can take a moment.`
        : `Summarizing ${ready.length} documents into one combined summary… this can take a moment.`,
      "busy"
    );
    try {
      const data = await requestSummary(ready);
      const label =
        ready.length === 1 ? ready[0].name : `Combined summary — ${ready.length} documents`;
      const base =
        (ready.length === 1 ? sanitizeFilename(ready[0].name) || "document" : "combined") +
        "_report_" + reportDate();
      addResultCard(label, base, data.summary, $("resultlist").firstChild, ready.length > 1);
      setStatus(
        `Done — review, then copy or download. (${data.chars.toLocaleString()} characters read across ` +
          `${ready.length} document${ready.length === 1 ? "" : "s"})`,
        "ok"
      );
    } catch (err) {
      setStatus(err.message || String(err), "error");
    }
  }

  // Each ready document -> its own summary -> its own card. Strictly one
  // /api/summarize-text call in flight at a time; a failure on one file
  // does not stop the rest.
  async function summarizeSeparately(ready) {
    // This run's cards go above older ones but keep their own top-down order.
    const before = $("resultlist").firstChild;
    const failures = [];
    for (let i = 0; i < ready.length; i++) {
      const item = ready[i];
      setStatus(`Summarizing ${i + 1} of ${ready.length}: ${item.name}…`, "busy");
      try {
        const data = await requestSummary([item]);
        const base = (sanitizeFilename(item.name) || "document") + "_report_" + reportDate();
        addResultCard(item.name, base, data.summary, before, false);
      } catch (err) {
        failures.push(`${item.name} — ${err.message || err}`);
      }
    }
    if (!failures.length) {
      setStatus(
        `Done — ${ready.length} ${ready.length === 1 ? "summary" : "summaries"} ready. ` +
          "Review, then copy or download.",
        "ok"
      );
    } else if (failures.length === ready.length) {
      setStatus(`Couldn't summarize: ${failures.join("; ")}`, "error");
    } else {
      setStatus(
        `Done with ${ready.length - failures.length} of ${ready.length}. ` +
          `Failed: ${failures.join("; ")}`,
        "error"
      );
    }
  }

  // ── downloads ─────────────────────────────────────────────────────────
  // Only safe, portable characters in a download name — a document name must
  // never inject path separators, control characters, or a spoofed extension.
  function sanitizeFilename(name) {
    const base = String(name || "").replace(/\.[^.]*$/, "");
    return base
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a beat to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Word opens HTML saved as .doc; <pre> + pre-wrap keeps the template's
  // line structure. Escape the text — it must never be interpreted as markup.
  function wordDocBlob(text) {
    const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html =
      '<html><head><meta charset="utf-8"><title>Summary</title></head><body>' +
      `<pre style="font-family:Calibri,Arial,sans-serif;white-space:pre-wrap;">${esc}</pre>` +
      "</body></html>";
    // Leading U+FEFF (BOM) so Word detects the file as UTF-8.
    return new Blob([String.fromCharCode(0xfeff), html], { type: "application/msword" });
  }

  // ── result cards ──────────────────────────────────────────────────────
  // One card per summary: label, editable textarea, Copy / .txt / .doc / PDF.
  // Copy and every download read the textarea AT CLICK TIME, so manual edits
  // are always included. Cards are built once and never re-rendered, so edits
  // survive later runs; "Clear all" removes the nodes (and their listeners).
  function addResultCard(label, downloadBase, summaryText, beforeNode, isCombined, listEl) {
    const card = document.createElement("article");
    card.className = "result-card";
    card.setAttribute("aria-label", "Summary: " + label);

    const bar = document.createElement("div");
    bar.className = "result-card-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "result-title";
    titleWrap.appendChild(svgIcon(isCombined ? ICON_COMBINED : ICON_DOC, 16));
    const title = document.createElement("h3");
    title.textContent = label;
    titleWrap.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "result-actions";

    const textarea = document.createElement("textarea");
    textarea.className = "summary-box";
    textarea.rows = 12;
    textarea.spellcheck = false;
    // autocomplete="off" prevents the browser's session-restore from
    // persisting this field's contents to disk.
    textarea.setAttribute("autocomplete", "off");
    textarea.setAttribute("aria-label", "Editable summary: " + label);
    textarea.value = summaryText;

    const copyBtn = smallButton("Copy", async () => {
      if (!textarea.value) return;
      try {
        await navigator.clipboard.writeText(textarea.value);
        setStatus("Copied to clipboard.", "ok");
      } catch {
        textarea.select();
        setStatus("Press Ctrl+C to copy the selected text.", "busy");
      }
    }, "btn btn-secondary");
    copyBtn.textContent = "";
    copyBtn.append(svgIcon(ICON_COPY, 13), document.createTextNode("Copy"));
    actions.appendChild(copyBtn);

    const txtBtn = smallButton(".txt", () => {
      if (!textarea.value) return;
      downloadBlob(new Blob([textarea.value], { type: "text/plain" }), downloadBase + ".txt");
      setStatus(".txt downloaded.", "ok");
    }, "btn btn-secondary");
    txtBtn.setAttribute("aria-label", "Download as .txt");
    actions.appendChild(txtBtn);

    const docBtn = smallButton(".doc", () => {
      if (!textarea.value) return;
      downloadBlob(wordDocBlob(textarea.value), downloadBase + ".doc");
      setStatus(".doc downloaded.", "ok");
    }, "btn btn-secondary");
    docBtn.setAttribute("aria-label", "Download as Word .doc");
    actions.appendChild(docBtn);

    const pdfBtn = smallButton("PDF", () => {
      if (!textarea.value) return;
      const bytes = window.PDFGen.textToPdf(textarea.value);
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), downloadBase + ".pdf");
      setStatus("PDF downloaded.", "ok");
    }, "btn btn-secondary");
    pdfBtn.setAttribute("aria-label", "Download as PDF");
    actions.appendChild(pdfBtn);

    bar.append(titleWrap, actions);
    const body = document.createElement("div");
    body.className = "result-body";
    body.appendChild(textarea);
    card.append(bar, body);
    const list = listEl || $("resultlist");
    // The anchor may have been detached by "Clear all" mid-run — fall back
    // to appending rather than throwing.
    const anchor = beforeNode && beforeNode.parentNode === list ? beforeNode : null;
    list.insertBefore(card, anchor);
    if (list.id === "comparelist") {
      $("compare-empty").hidden = true;
    } else {
      $("results").hidden = false;
      $("emptystate").hidden = true; // onboarding yields to the first real result
      renderCurrWellChip(); // the This-week well can now offer "Use latest summary"
    }
  }

  // ── week-over-week comparison ─────────────────────────────────────────
  // Nothing persists between sessions (deliberately — see the privacy notes),
  // so "last week" arrives as the exported report file. "This week" is a file
  // too, or one click on the summary just produced in this session.
  const wells = {
    prev: { status: "empty", filename: "", text: "", chars: 0, error: "" },
    curr: { status: "empty", filename: "", text: "", chars: 0, error: "" },
  };
  let comparing = false;

  function latestSummaryCard() {
    return $("resultlist").querySelector(".summary-box");
  }

  // The This-week well offers "Use latest summary" only while it's empty AND
  // a summary card exists — never clobbers a file the user already chose.
  function renderCurrWellChip() {
    if (wells.curr.status === "empty") renderWell("curr");
  }

  function wellIds(key) {
    return key === "prev"
      ? { well: "well-prev", body: "well-prev-body", input: "well-prev-input" }
      : { well: "well-curr", body: "well-curr-body", input: "well-curr-input" };
  }

  function renderWell(key) {
    const ids = wellIds(key);
    const well = $(ids.well);
    const body = $(ids.body);
    const st = wells[key];
    well.classList.toggle("is-ready", st.status === "ready");
    well.classList.toggle("is-error", st.status === "error");
    body.textContent = ""; // rebuild; textContent everywhere — never innerHTML

    if (st.status === "extracting") {
      const line = document.createElement("span");
      line.append(spinnerEl(), document.createTextNode(" Extracting…"));
      body.appendChild(line);
      return;
    }

    if (st.status === "ready") {
      const row = document.createElement("div");
      row.className = "well-file";
      const type = fileTypeClass(st.filename);
      const ftype = document.createElement("div");
      ftype.className = "ftype ftype-" + type;
      ftype.appendChild(svgIcon(type === "doc" ? ICON_DOC : ICON_FILE));
      const main = document.createElement("div");
      main.className = "file-main";
      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = st.filename;
      const meta = document.createElement("div");
      meta.className = "file-meta";
      meta.appendChild(statusPill("green", `${st.chars.toLocaleString()} characters read`, { withCheck: true }));
      main.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "well-actions";
      actions.appendChild(
        smallButton("Remove", () => {
          wells[key] = { status: "empty", filename: "", text: "", chars: 0, error: "" };
          renderWell(key);
          updateCompareButton();
        })
      );
      row.append(ftype, main, actions);
      body.appendChild(row);
      return;
    }

    if (st.status === "error") {
      body.appendChild(statusPill("red", st.error));
    } else {
      const hint = document.createElement("span");
      hint.textContent = "Drop the exported report here, or";
      body.appendChild(hint);
    }
    body.appendChild(
      smallButton(st.status === "error" ? "choose another file" : "choose a file", (e) => {
        e.stopPropagation();
        $(ids.input).click();
      }, "link-btn")
    );
    if (key === "curr" && latestSummaryCard()) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "well-chip";
      chip.append(svgIcon(ICON_COMBINED, 13), document.createTextNode("Use latest summary"));
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        useLatestSummary();
      });
      body.appendChild(chip);
    }
  }

  function useLatestSummary() {
    const box = latestSummaryCard();
    if (!box) return;
    const card = box.closest(".result-card");
    const title = card && card.querySelector("h3");
    wells.curr = {
      status: "ready",
      filename: (title && title.textContent) || "Current summary",
      text: box.value, // the CURRENT text, edits included
      chars: box.value.length,
      error: "",
    };
    renderWell("curr");
    updateCompareButton();
  }

  async function setWellFile(key, file) {
    if (!file || comparing) return;
    const name = file.name || "document";
    if (file.size === 0) {
      wells[key] = { status: "error", filename: name, text: "", chars: 0, error: "Empty file — nothing to read." };
    } else if (file.size > MAX_UPLOAD_BYTES) {
      wells[key] = { status: "error", filename: name, text: "", chars: 0, error: "Over the 25 MB limit — try a smaller file." };
    } else {
      wells[key] = { status: "extracting", filename: name, text: "", chars: 0, error: "" };
      renderWell(key);
      updateCompareButton();
      try {
        const res = await fetchWithTimeout(
          "/api/extract",
          {
            method: "POST",
            headers: {
              "content-type": "application/octet-stream",
              "x-filename": encodeURIComponent(name),
            },
            body: file,
          },
          LONG_TIMEOUT_MS,
          TIMEOUT_MESSAGE
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        wells[key] = { status: "ready", filename: name, text: data.text, chars: data.chars, error: "" };
      } catch (err) {
        wells[key] = { status: "error", filename: name, text: "", chars: 0, error: err.message || String(err) };
      }
    }
    renderWell(key);
    updateCompareButton();
  }

  function updateCompareButton() {
    const both = wells.prev.status === "ready" && wells.curr.status === "ready";
    $("compare-btn").disabled = comparing || !both;
    $("compare-label").textContent = comparing ? "Comparing…" : "Compare weeks";
  }

  async function compareWeeks() {
    if (comparing || wells.prev.status !== "ready" || wells.curr.status !== "ready") return;
    comparing = true;
    updateCompareButton();
    setStatus("Comparing last week's report to this week's… this can take a moment.", "busy");
    try {
      const res = await fetchWithTimeout(
        "/api/compare",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            previous: { filename: wells.prev.filename, text: wells.prev.text },
            current: { filename: wells.curr.filename, text: wells.curr.text },
          }),
        },
        LONG_TIMEOUT_MS,
        TIMEOUT_MESSAGE
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      addResultCard(
        "Week-over-week review",
        "week_comparison_" + reportDate(),
        data.comparison,
        $("comparelist").firstChild,
        true,
        $("comparelist")
      );
      setStatus(
        `Comparison ready — review, then copy or download. (${data.chars.toLocaleString()} characters compared)`,
        "ok"
      );
    } catch (err) {
      setStatus(err.message || String(err), "error");
    } finally {
      comparing = false;
      updateCompareButton();
    }
  }

  // ── tabs ──────────────────────────────────────────────────────────────
  function switchTab(tab) {
    activeTab = tab;
    const isSum = tab === "summaries";
    $("panel-summaries").hidden = !isSum;
    $("panel-compare").hidden = isSum;
    $("tab-summaries").classList.toggle("is-active", isSum);
    $("tab-compare").classList.toggle("is-active", !isSum);
    $("tab-summaries").setAttribute("aria-selected", String(isSum));
    $("tab-compare").setAttribute("aria-selected", String(!isSum));
  }

  // ── wiring ────────────────────────────────────────────────────────────
  function wire() {
    const drop = $("dropzone");
    const picker = $("filepicker");

    // Handle drops at the WINDOW level: a drop that misses the dropzone must
    // not trigger the browser default (navigating the tab to the file), which
    // would silently destroy the current summaries. A near-miss counts as
    // intent, so stray drops feed the queue too.
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("dropzone--over");
      const files = e.dataTransfer ? e.dataTransfer.files : null;
      if (!files || !files.length) return;
      const t = e.target instanceof Element ? e.target : null;
      // A drop on a compare well fills that well; a stray drop while the
      // Compare tab is open fills the first open slot; anything else joins
      // the summarize queue (including drops on the left pane).
      const wellEl = t && t.closest(".well");
      if (wellEl) return void setWellFile(wellEl.id === "well-prev" ? "prev" : "curr", files[0]);
      if (activeTab === "compare" && !(t && t.closest(".pane-left"))) {
        return void setWellFile(wells.prev.status !== "ready" ? "prev" : "curr", files[0]);
      }
      addFiles(files);
    });

    ["dragenter", "dragover"].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.add("dropzone--over");
      })
    );
    drop.addEventListener("dragleave", () => drop.classList.remove("dropzone--over"));

    drop.addEventListener("click", () => picker.click());
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        picker.click();
      }
    });
    picker.addEventListener("change", () => {
      addFiles(picker.files);
      picker.value = ""; // let the same file be re-picked
    });

    $("summarize").addEventListener("click", summarize);

    // Mode changes retitle the Summarize button ("together" vs "separately").
    document.querySelectorAll('input[name="mode"]').forEach((r) =>
      r.addEventListener("change", updateSummarizeButton)
    );

    // Clear all clears whichever view is open.
    $("clear").addEventListener("click", () => {
      if (activeTab === "compare") {
        $("comparelist").textContent = ""; // drops every card and its listeners
        $("compare-empty").hidden = false;
      } else {
        $("resultlist").textContent = "";
        $("results").hidden = true;
        $("emptystate").hidden = false; // back to the onboarding guide
        renderCurrWellChip(); // no summaries left → the chip disappears
      }
      setStatus("");
    });

    $("tab-summaries").addEventListener("click", () => switchTab("summaries"));
    $("tab-compare").addEventListener("click", () => switchTab("compare"));
    $("compare-btn").addEventListener("click", compareWeeks);

    for (const key of ["prev", "curr"]) {
      const ids = wellIds(key);
      const well = $(ids.well);
      const input = $(ids.input);
      // Clicking anywhere on an unfilled well opens the picker; buttons
      // inside (Remove, chip, link) handle themselves.
      well.addEventListener("click", (e) => {
        if (e.target instanceof Element && e.target.closest("button")) return;
        if (wells[key].status !== "ready") input.click();
      });
      ["dragenter", "dragover"].forEach((ev) =>
        well.addEventListener(ev, () => well.classList.add("is-over"))
      );
      ["dragleave", "drop"].forEach((ev) =>
        well.addEventListener(ev, () => well.classList.remove("is-over"))
      );
      input.addEventListener("change", () => {
        if (input.files[0]) setWellFile(key, input.files[0]);
        input.value = ""; // let the same file be re-picked
      });
    }

    render();
    renderWell("prev");
    renderWell("curr");
    updateCompareButton();
    checkHealth();
  }

  document.addEventListener("DOMContentLoaded", wire);
})();
