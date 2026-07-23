// Front-end: drop one or more files -> each is text-extracted via the local
// server (POST /api/extract, strictly one upload in flight at a time) -> then
// either ONE combined summary or one summary per file (POST /api/summarize-text,
// also strictly sequential). Files never go anywhere except 127.0.0.1; the
// local server forwards them.
// Summaries arrive as Markdown and are shown as a formatted preview rendered
// by markdown.js (window.MD — loaded before this file); an Edit toggle swaps
// in the raw-text textarea, which stays the source of truth for copy/downloads.
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
  const ICON_UNDO = ["M1 4v6h6", "M3.51 15a9 9 0 1 0 2.13-9.36L1 10"];

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

  // Download names carry TODAY'S date (the day the file was saved):
  // report_7_21_2026.pdf. This is deliberately different from the date
  // INSIDE the report — the server injects the reporting week's Friday
  // (lib/template.mjs dateRule) for the "Notes for the week ending …" line.
  function reportDate() {
    const d = new Date();
    return `${d.getMonth() + 1}_${d.getDate()}_${d.getFullYear()}`;
  }

  // ── step 1: last week's report ────────────────────────────────────────
  // Loaded from the file exported last week; rides along with every
  // summarize call so trends/statuses/"key changes" are judged against real
  // prior-week evidence. Gate: Summarize stays off until this is ready or
  // the "first report" box is ticked.
  const prevWell = { status: "empty", filename: "", text: "", chars: 0, error: "" };

  function renderPrevWell() {
    const well = $("prev-well");
    const body = $("prev-well-body");
    well.classList.toggle("is-ready", prevWell.status === "ready");
    well.classList.toggle("is-error", prevWell.status === "error");
    body.textContent = ""; // rebuild; textContent everywhere — never innerHTML

    if (prevWell.status === "extracting") {
      const line = document.createElement("span");
      line.append(spinnerEl(), document.createTextNode(" Extracting…"));
      body.appendChild(line);
    } else if (prevWell.status === "ready") {
      const row = document.createElement("div");
      row.className = "well-file";
      const type = fileTypeClass(prevWell.filename);
      const ftype = document.createElement("div");
      ftype.className = "ftype ftype-" + type;
      ftype.appendChild(svgIcon(type === "doc" ? ICON_DOC : ICON_FILE));
      const main = document.createElement("div");
      main.className = "file-main";
      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = prevWell.filename;
      const meta = document.createElement("div");
      meta.className = "file-meta";
      meta.appendChild(statusPill("green", `${prevWell.chars.toLocaleString()} characters read`, { withCheck: true }));
      main.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "well-actions";
      actions.appendChild(
        smallButton("Remove", () => {
          Object.assign(prevWell, { status: "empty", filename: "", text: "", chars: 0, error: "" });
          renderPrevWell();
          updateSummarizeButton();
        })
      );
      row.append(ftype, main, actions);
      body.appendChild(row);
    } else {
      if (prevWell.status === "error") {
        body.appendChild(statusPill("red", prevWell.error));
      } else {
        const hint = document.createElement("span");
        hint.textContent = "Drop last week's report here, or";
        body.appendChild(hint);
      }
      body.appendChild(
        smallButton(prevWell.status === "error" ? "choose another file" : "choose a file", (e) => {
          e.stopPropagation();
          $("prev-well-input").click();
        }, "link-btn")
      );
    }
    // The first-report checkbox only matters while there's no report loaded.
    $("firstreport-row").hidden = prevWell.status === "ready";
    updateSummarizeButton();
  }

  async function setPrevFile(file) {
    if (!file) return;
    const name = file.name || "document";
    if (file.size === 0) {
      Object.assign(prevWell, { status: "error", filename: name, text: "", chars: 0, error: "Empty file — nothing to read." });
      renderPrevWell();
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      Object.assign(prevWell, { status: "error", filename: name, text: "", chars: 0, error: "Over the 25 MB limit — try a smaller file." });
      renderPrevWell();
      return;
    }
    Object.assign(prevWell, { status: "extracting", filename: name, text: "", chars: 0, error: "" });
    renderPrevWell();
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
      Object.assign(prevWell, { status: "ready", filename: name, text: data.text, chars: data.chars, error: "" });
    } catch (err) {
      Object.assign(prevWell, { status: "error", filename: name, text: "", chars: 0, error: err.message || String(err) });
    }
    renderPrevWell();
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

  // A small muted caption shown above an editable field in edit mode, so the
  // two textareas (suggested changes / this week's document) are never
  // ambiguous. Text always lands via textContent.
  function editFieldLabel(text) {
    const el = document.createElement("div");
    el.className = "field-label";
    el.textContent = text;
    el.hidden = true;
    return el;
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

  // Step 1 satisfied? Last week's report loaded, or "first report" ticked.
  function priorGateOpen() {
    return prevWell.status === "ready" || $("firstreport").checked;
  }

  function updateSummarizeButton() {
    const btn = $("summarize");
    const ready = queue.filter((f) => f.status === "ready").length;
    const pending = queue.some((f) => f.status === "queued" || f.status === "extracting");
    const gate = priorGateOpen();
    btn.disabled = summarizing || pending || ready === 0 || !gate;
    // Only the label span — writing btn.textContent would wipe the sparkle icon.
    $("summarize-label").textContent = summarizing
      ? "Checking…"
      : pending
        ? "Extracting…"
        : ready > 1
          ? currentMode() === "separate"
            ? `Check ${ready} documents separately`
            : `Check ${ready} documents together`
          : "Check for changes";
    // Explain the only non-obvious blocker: files are ready but step 1 isn't.
    $("gate-hint").hidden = !(ready > 0 && !pending && !summarizing && !gate);
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
  // Snapshot of the extracted texts a summary was built from, captured at
  // request time so the card's "Source check" (verify.js) still works after
  // files are removed from the queue. Strings only; memory, never disk.
  function cardSources(items) {
    const s = items.map((f) => ({ name: f.name, text: f.text }));
    if (prevWell.status === "ready") {
      // prior:true — usable for "where did this come from", but reference
      // material, so verify.js never flags it as content the report "left out".
      s.push({ name: "Last week's report (" + prevWell.filename + ")", text: prevWell.text, prior: true });
    }
    return s;
  }

  async function requestSummary(docs) {
    const body = {
      documents: docs.map((f) => ({ filename: f.name, text: f.text })),
    };
    // Last week's report rides along so trends/"key changes" are judged
    // against real prior-week evidence. Omitted entirely on a first report.
    if (prevWell.status === "ready") {
      body.previous = { filename: prevWell.filename, text: prevWell.text };
    }
    const res = await fetchWithTimeout(
      "/api/summarize-text",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      LONG_TIMEOUT_MS,
      TIMEOUT_MESSAGE
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // Change-review request: this week's extracted text (+ last week's report when
  // loaded) -> { changes } — a short suggested-changes block. The verbatim body
  // is assembled in the browser from these same docs and never sent back, so a
  // failure here still leaves this week's document to render. Single pass: the
  // block is small, so best-of-N (a summary-quality device) does not apply.
  async function requestChanges(docs) {
    const body = {
      documents: docs.map((f) => ({ filename: f.name, text: f.text })),
    };
    if (prevWell.status === "ready") {
      body.previous = { filename: prevWell.filename, text: prevWell.text };
    }
    const res = await fetchWithTimeout(
      "/api/suggest-changes",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      LONG_TIMEOUT_MS,
      TIMEOUT_MESSAGE
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // Best-of-N: the gateway is nondeterministic, so the same inputs yield
  // different reports run-to-run. Rather than ship whichever run happened,
  // generate a few candidates and keep the best MEASURED one — most grounded,
  // then most complete, then tightest (verify.js selectBest). Diversity comes
  // from DOCUMENT ORDER only (candidate 1 = canonical order, others rotated):
  // temperature stays 0.0, so the calibrated template is never perturbed and
  // no server/template change is needed. Candidate 1 is the canonical floor,
  // so the result can never be worse than a single-shot run. Sequential
  // (matches the app's one-at-a-time design); a failed candidate just shrinks
  // the pool. Invisible to the reviewer by design — see USER-GUIDE.
  const BEST_OF = 3;
  function rotate(arr, n) {
    const k = arr.length ? n % arr.length : 0;
    return k ? arr.slice(k).concat(arr.slice(0, k)) : arr.slice();
  }
  async function requestBestSummary(docs, onProgress) {
    // Reordering only diversifies with 2+ documents; below that, one pass.
    const n = docs.length >= 2 ? BEST_OF : 1;
    const summaries = [];
    let chars = 0;
    let lastErr = null;
    for (let i = 0; i < n; i++) {
      if (onProgress) onProgress(i, n);
      try {
        const data = await requestSummary(rotate(docs, i));
        summaries.push(data.summary);
        if (!chars) chars = data.chars;
      } catch (err) {
        lastErr = err; // accumulate successes; a failed candidate shrinks the pool
      }
    }
    if (!summaries.length) throw lastErr || new Error("Couldn't build the report — please try again.");
    // Without the scorer we can't rank — ship the canonical (first) candidate.
    if (summaries.length === 1 || !window.Verify) return { summary: summaries[0], chars };
    const pick = window.Verify.selectBest(summaries, cardSources(docs));
    // Quiet audit trail (dev console): which candidate won and why. Keeps the
    // deterministic gate-then-rank decision inspectable without touching the UI.
    try {
      console.info(
        `[source-check] best of ${summaries.length}: chose #${pick.index + 1}`,
        pick.all.map((c) => ({ unverified: c.ungrounded, possiblyMissing: c.omissions, length: c.length }))
      );
    } catch (_) {}
    return { summary: pick.summary, chars };
  }

  async function summarize() {
    const ready = queue.filter((f) => f.status === "ready");
    if (!ready.length || summarizing || !priorGateOpen()) return;
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

  // All ready documents -> ONE card: this week's text reproduced VERBATIM as the
  // body, with a red "suggested changes" block on top from the change-review
  // call. The body is assembled here in the browser (never sent to the model),
  // so it is guaranteed this-week-only, unedited, and always renders — even when
  // the change check itself fails.
  async function summarizeCombined(ready) {
    const only = ready.length === 1;
    const bodyText = ready.map((f) => f.text).join("\n\n");
    const label = only ? ready[0].name : `This week — ${ready.length} documents`;
    const base = "report_" + reportDate();
    const before = $("resultlist").firstChild;
    setStatus(
      only
        ? `Checking "${ready[0].name}" against last week… this can take a moment.`
        : `Checking ${ready.length} documents against last week… this can take a moment.`,
      "busy"
    );
    let changes;
    try {
      changes = (await requestChanges(ready)).changes;
    } catch (err) {
      // The change check failed; still show this week's document unchanged.
      changes =
        "**Suggested changes**\n\n- Could not compare against last week (" +
        (err.message || String(err)) +
        "). This week's document is shown below unchanged.";
      addResultCard(label, base, { changes, body: bodyText }, before, ready.length > 1);
      setStatus(
        "Showing this week's document. The change check didn't run: " + (err.message || String(err)),
        "error"
      );
      return;
    }
    addResultCard(label, base, { changes, body: bodyText }, before, ready.length > 1);
    setStatus(
      "Done — suggested changes are at the top in red; this week's document is below. Review, then copy or download.",
      "ok"
    );
  }

  // Each ready document -> its own card (its verbatim body + its own change
  // block vs last week). Strictly one /api/suggest-changes call at a time; a
  // failure on one file still shows that file's document with a note.
  async function summarizeSeparately(ready) {
    // This run's cards go above older ones but keep their own top-down order.
    const before = $("resultlist").firstChild;
    const failures = [];
    for (let i = 0; i < ready.length; i++) {
      const item = ready[i];
      const base = (sanitizeFilename(item.name) || "document") + "_report_" + reportDate();
      setStatus(`Checking ${i + 1} of ${ready.length}: ${item.name}…`, "busy");
      let changes;
      try {
        changes = (await requestChanges([item])).changes;
      } catch (err) {
        changes =
          "**Suggested changes**\n\n- Could not compare against last week (" +
          (err.message || String(err)) +
          ").";
        failures.push(`${item.name} — ${err.message || err}`);
      }
      addResultCard(item.name, base, { changes, body: item.text }, before, false);
    }
    if (!failures.length) {
      setStatus(
        `Done — ${ready.length} ${ready.length === 1 ? "document" : "documents"} ready with suggested changes. ` +
          "Review, then copy or download.",
        "ok"
      );
    } else if (failures.length === ready.length) {
      setStatus(`Showed your document${ready.length === 1 ? "" : "s"}, but the change check didn't run: ${failures.join("; ")}`, "error");
    } else {
      setStatus(
        `Done with ${ready.length - failures.length} of ${ready.length}. ` +
          `Change check didn't run for: ${failures.join("; ")}`,
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

  // ── two-part export: red "Suggested changes" on top + verbatim body below ─
  // Both halves are rebuilt from parsed Markdown through MD.toHtml, which
  // escapes every text node — raw model/document text never reaches the markup
  // as a string. MD's static inline EXPORT_STYLES (Calibri, pt heading sizes,
  // bordered tables with a shaded header row, bullets, ruled <hr>) survive
  // Word/Outlook import. The RED is an inline `color` on a wrapper div: Word
  // and Outlook ignore <style> blocks but honor inline color, and EXPORT_STYLES
  // set no color of their own, so #C00000 cascades into every heading/bullet/
  // bold in the changes half; the body half is pinned near-black so it can
  // never inherit the red.
  function composeExportHtml(changesText, bodyText) {
    const changes = String(changesText || "").trim();
    const bodyHtml = window.MD.toHtml(window.MD.parse(String(bodyText || "")));
    const parts = ['<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#111111;">'];
    if (changes) {
      parts.push('<div style="color:#C00000;">' + window.MD.toHtml(window.MD.parse(changes)) + "</div>");
      parts.push('<hr style="border:none;border-top:1.5pt solid #7f7f7f;margin:12pt 0;">');
    }
    parts.push('<div style="color:#111111;">' + bodyHtml + "</div>");
    parts.push("</div>");
    return parts.join("");
  }

  // Plain-text twin of composeExportHtml (clipboard text/plain, .txt, PDF).
  function composeExportText(changesText, bodyText) {
    const changes = String(changesText || "").trim();
    return (changes ? changes + "\n\n----------\n\n" : "") + String(bodyText || "");
  }

  // Word opens HTML saved as .doc. The two-part body comes from
  // composeExportHtml (escaped throughout); the mso conditional asks Word for
  // Print Layout, and the leading U+FEFF (BOM) makes Word detect UTF-8.
  function wordDocBlob(changesText, bodyText) {
    const html =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:w="urn:schemas-microsoft-com:office:word">' +
      '<head><meta charset="utf-8"><title>This week’s document</title>' +
      "<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View>" +
      "<w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->" +
      "</head><body>" +
      composeExportHtml(changesText, bodyText) +
      "</body></html>";
    return new Blob([String.fromCharCode(0xfeff), html], { type: "application/msword" });
  }

  // ── result cards ──────────────────────────────────────────────────────
  // One card per run: a red "suggested changes" block on top and this week's
  // document reproduced VERBATIM below, each with a formatted preview ⇄ editable
  // textarea (Edit/Preview toggle) and Copy / .txt / .doc / PDF. Both halves
  // render through window.MD (createElement/textContent only — untrusted model
  // and document text). The two textareas are the single source of truth: Copy
  // and every download read them AT CLICK TIME, so manual edits are always
  // included. Cards are built once and never re-rendered, so edits survive later
  // runs; "Clear all" removes the nodes (and their listeners).
  // ── result tabs ──────────────────────────────────────────────────────
  // Each result lives in its own browser-style tab instead of stacking down the
  // page. Switching tabs only flips each card's hidden flag — cards are never
  // re-rendered, so textarea edits survive switching. Closing a tab removes that
  // one card for good ("Clear all" for a single result).
  let tabSeq = 0;
  function activateResultTab(id) {
    for (const t of $("resulttabs").children) {
      const on = t.dataset.tid === id;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    }
    for (const c of $("resultlist").children) c.hidden = c.dataset.tid !== id;
  }
  function closeResultTab(id) {
    const tabs = $("resulttabs");
    const find = (parent) =>
      Array.prototype.find.call(parent.children, (el) => el.dataset.tid === id);
    const tab = find(tabs);
    const card = find($("resultlist"));
    const wasActive = tab && tab.classList.contains("is-active");
    const neighbor = tab && (tab.nextElementSibling || tab.previousElementSibling);
    if (tab) tab.remove();
    if (card) card.remove();
    if (!tabs.children.length) {
      $("results").hidden = true;
      $("emptystate").hidden = false;
    } else if (wasActive && neighbor) {
      activateResultTab(neighbor.dataset.tid);
    }
  }

  // One card = this week's document reproduced VERBATIM (bodyBox), with a red
  // "suggested changes" block on top (changesBox). Each textarea is the source
  // of truth for its half and is read AT CLICK TIME by Copy and every download,
  // so manual edits to either half are always included. No source-check /
  // line-delete / boilerplate decorators here: the body is verbatim (nothing to
  // ground or flag) and the changes block is advisory.
  function addResultCard(label, downloadBase, content, beforeNode, isCombined) {
    const changesText = (content && content.changes) || "";
    const bodyText = (content && content.body) || "";

    const card = document.createElement("article");
    card.className = "result-card";
    card.setAttribute("aria-label", "This week's document: " + label);

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

    // Source-of-truth textareas (hidden until Edit): the red suggested-changes
    // block and the verbatim this-week body.
    const changesBox = document.createElement("textarea");
    changesBox.className = "summary-box changes-box";
    changesBox.rows = 5;
    changesBox.spellcheck = false;
    changesBox.setAttribute("autocomplete", "off"); // keep out of session-restore
    changesBox.setAttribute("aria-label", "Editable suggested changes: " + label);
    changesBox.value = changesText;
    changesBox.hidden = true;

    const bodyBox = document.createElement("textarea");
    bodyBox.className = "summary-box body-box";
    bodyBox.rows = 16;
    bodyBox.spellcheck = false;
    bodyBox.setAttribute("autocomplete", "off");
    bodyBox.setAttribute("aria-label", "Editable document text: " + label);
    bodyBox.value = bodyText;
    bodyBox.hidden = true;

    // Formatted previews (default view): the changes block is red
    // (.suggested-changes); the body echoes the Word template (.summary-preview).
    // Both rebuilt from the CURRENT textarea values whenever edit mode is left.
    const changesPreview = document.createElement("div");
    changesPreview.className = "suggested-changes";
    changesPreview.setAttribute("aria-label", "Suggested changes: " + label);

    const bodyPreview = document.createElement("div");
    bodyPreview.className = "summary-preview";
    bodyPreview.setAttribute("aria-label", "This week's document: " + label);

    // Captions shown only in edit mode so the two editable fields are clear.
    const changesEditLabel = editFieldLabel("Suggested changes (review, then delete before sending)");
    const bodyEditLabel = editFieldLabel("This week's document");

    function renderPreview() {
      changesPreview.textContent = "";
      changesPreview.appendChild(window.MD.render(window.MD.parse(changesBox.value)));
      bodyPreview.textContent = "";
      bodyPreview.appendChild(window.MD.render(window.MD.parse(bodyBox.value)));
    }
    renderPreview();

    // Edit ⇄ Preview toggle: swaps both previews for both textareas at once.
    let editing = false;
    function setEditing(on) {
      editing = on;
      if (!on) renderPreview(); // returning to preview picks up manual edits
      if (bodyPreview.parentNode) bodyPreview.parentNode.classList.toggle("is-editing", on);
      changesPreview.hidden = on;
      bodyPreview.hidden = on;
      changesEditLabel.hidden = !on;
      bodyEditLabel.hidden = !on;
      changesBox.hidden = !on;
      bodyBox.hidden = !on;
      editBtn.textContent = on ? "Preview" : "Edit";
      editBtn.setAttribute("aria-pressed", String(on));
      editBtn.classList.toggle("is-active", on);
      if (on) changesBox.focus();
    }
    const editBtn = smallButton("Edit", () => setEditing(!editing), "btn btn-secondary");
    editBtn.setAttribute("aria-pressed", "false");
    editBtn.setAttribute("aria-label", "Switch between formatted preview and editable text");
    actions.appendChild(editBtn);

    // Copy lands rich (text/html — Word/Outlook keep the red block + formatting
    // on paste) AND plain (text/plain) in one clipboard write. Fallbacks: plain
    // writeText, then select-for-Ctrl+C in edit mode.
    const copyBtn = smallButton("Copy", async () => {
      const html = composeExportHtml(changesBox.value, bodyBox.value);
      const text = composeExportText(changesBox.value, bodyBox.value);
      if (!text) return;
      try {
        if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem === "function") {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/html": new Blob([html], { type: "text/html" }),
              "text/plain": new Blob([text], { type: "text/plain" }),
            }),
          ]);
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          throw new Error("clipboard unavailable");
        }
        setStatus("Copied — paste into your email.", "ok");
      } catch {
        try {
          await navigator.clipboard.writeText(text);
          setStatus("Copied — paste into your email.", "ok");
        } catch {
          setEditing(true); // a textarea must be visible to select it
          bodyBox.select();
          setStatus("Press Ctrl+C to copy the selected text.", "busy");
        }
      }
    }, "btn btn-secondary");
    copyBtn.textContent = "";
    copyBtn.append(svgIcon(ICON_COPY, 13), document.createTextNode("Copy"));
    actions.appendChild(copyBtn);

    const txtBtn = smallButton(".txt", () => {
      const text = composeExportText(changesBox.value, bodyBox.value);
      if (!text) return;
      downloadBlob(new Blob([text], { type: "text/plain" }), downloadBase + ".txt");
      setStatus(".txt downloaded.", "ok");
    }, "btn btn-secondary");
    txtBtn.setAttribute("aria-label", "Download as .txt");
    actions.appendChild(txtBtn);

    const docBtn = smallButton(".doc", () => {
      if (!bodyBox.value && !changesBox.value) return;
      downloadBlob(wordDocBlob(changesBox.value, bodyBox.value), downloadBase + ".doc");
      setStatus(".doc downloaded.", "ok");
    }, "btn btn-secondary");
    docBtn.setAttribute("aria-label", "Download as Word .doc");
    actions.appendChild(docBtn);

    const pdfBtn = smallButton("PDF", () => {
      const text = composeExportText(changesBox.value, bodyBox.value);
      if (!text) return;
      const bytes = window.PDFGen.textToPdf(text);
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), downloadBase + ".pdf");
      setStatus("PDF downloaded.", "ok");
    }, "btn btn-secondary");
    pdfBtn.setAttribute("aria-label", "Download as PDF");
    actions.appendChild(pdfBtn);

    bar.append(titleWrap, actions);
    const body = document.createElement("div");
    body.className = "result-body";
    // Order: changes (caption + preview + box) then body (caption + preview +
    // box). Preview mode shows the two previews; edit mode shows the captions +
    // textareas. hidden flags (set above / in setEditing) pick which.
    body.append(changesEditLabel, changesPreview, changesBox, bodyEditLabel, bodyPreview, bodyBox);
    card.append(bar, body);
    const list = $("resultlist");
    // The anchor may have been detached by "Clear all" mid-run — fall back
    // to appending rather than throwing.
    const anchor = beforeNode && beforeNode.parentNode === list ? beforeNode : null;
    list.insertBefore(card, anchor);

    // Build this card's tab at the mirrored position, then bring it to front.
    const tid = String(++tabSeq);
    card.dataset.tid = tid;
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "result-tab";
    tab.dataset.tid = tid;
    tab.setAttribute("role", "tab");
    tab.appendChild(svgIcon(isCombined ? ICON_COMBINED : ICON_DOC, 13));
    const tlabel = document.createElement("span");
    tlabel.className = "result-tab-label";
    tlabel.textContent = label;
    tlabel.title = label;
    tab.appendChild(tlabel);
    const tclose = document.createElement("span");
    tclose.className = "result-tab-close";
    tclose.textContent = "×";
    tclose.setAttribute("role", "button");
    tclose.setAttribute("aria-label", "Close this summary");
    tclose.title = "Close this summary";
    tclose.addEventListener("click", (e) => {
      e.stopPropagation();
      closeResultTab(tid);
    });
    tab.appendChild(tclose);
    tab.addEventListener("click", () => activateResultTab(tid));
    const tabs = $("resulttabs");
    tabs.insertBefore(tab, tabs.children[Array.prototype.indexOf.call(list.children, card)] || null);
    activateResultTab(tid);

    $("results").hidden = false;
    $("emptystate").hidden = true; // onboarding yields to the first real result
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
      // A drop on the step-1 well loads last week's report; anything else
      // joins the summarize queue (including drops on the left pane).
      const wellEl = t && t.closest(".well");
      if (wellEl && wellEl.id === "prev-well") return void setPrevFile(files[0]);
      addFiles(files);
    });

    // Step-1 well: click to choose (buttons inside handle themselves),
    // drag highlight, picker change, and the first-report checkbox gate.
    const pwell = $("prev-well");
    const pinput = $("prev-well-input");
    pwell.addEventListener("click", (e) => {
      if (e.target instanceof Element && e.target.closest("button")) return;
      if (prevWell.status !== "ready") pinput.click();
    });
    ["dragenter", "dragover"].forEach((ev) =>
      pwell.addEventListener(ev, () => pwell.classList.add("is-over"))
    );
    ["dragleave", "drop"].forEach((ev) =>
      pwell.addEventListener(ev, () => pwell.classList.remove("is-over"))
    );
    pinput.addEventListener("change", () => {
      if (pinput.files[0]) setPrevFile(pinput.files[0]);
      pinput.value = ""; // let the same file be re-picked
    });
    $("firstreport").addEventListener("change", updateSummarizeButton);

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

    // Clear all empties the results view (cards AND their tabs).
    $("clear").addEventListener("click", () => {
      $("resultlist").textContent = ""; // drops every card and its listeners
      $("resulttabs").textContent = "";
      $("results").hidden = true;
      $("emptystate").hidden = false; // back to the onboarding guide
      setStatus("");
    });

    // Documents-panel collapse: tuck the left pane away so summaries get
    // the full window; a slim rail brings it back. Only this boolean ever
    // touches localStorage — never file names or content.
    const workspace = document.querySelector(".workspace");
    function setLeftCollapsed(on) {
      workspace.classList.toggle("left-collapsed", on);
      $("pane-expand").hidden = !on;
      try {
        localStorage.setItem("docsum.leftCollapsed", on ? "1" : "0");
      } catch {}
    }
    $("pane-toggle").addEventListener("click", () => setLeftCollapsed(true));
    $("pane-expand").addEventListener("click", () => setLeftCollapsed(false));
    try {
      if (localStorage.getItem("docsum.leftCollapsed") === "1") setLeftCollapsed(true);
    } catch {}

    // Limits dialog: native <dialog> gives Esc + focus handling for free;
    // clicking the backdrop (the dialog element itself) also closes it.
    $("limits").addEventListener("click", () => $("limits-dialog").showModal());
    $("limits-close").addEventListener("click", () => $("limits-dialog").close());
    $("limits-dialog").addEventListener("click", (e) => {
      if (e.target === $("limits-dialog")) $("limits-dialog").close();
    });

    render();
    renderPrevWell();
    checkHealth();
  }

  document.addEventListener("DOMContentLoaded", wire);
})();
