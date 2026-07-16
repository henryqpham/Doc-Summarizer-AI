// ─────────────────────────────────────────────────────────────────────────
//  APP — wire the UI: drag-drop → extract → summarize → show → copy.
// ─────────────────────────────────────────────────────────────────────────
window.DS = window.DS || {};

(function () {
  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, kind) {
    const el = $("status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " status--" + kind : "");
  }

  async function handleFile(file) {
    try {
      setStatus(`Reading "${file.name}"…`, "busy");
      const text = await DS.extract.fromFile(file);
      if (!text) throw new Error("No text could be extracted from this file.");

      setStatus("Summarizing…", "busy");
      const summary = await DS.api.summarize(text);

      $("output").value = summary;
      setStatus("Done — review, then copy.", "ok");
    } catch (err) {
      console.error(err);
      setStatus(err.message || String(err), "error");
    }
  }

  function wire() {
    const drop = $("dropzone");
    const picker = $("filepicker");

    ["dragenter", "dragover"].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.add("dropzone--over");
      })
    );
    ["dragleave", "drop"].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.remove("dropzone--over");
      })
    );

    drop.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });
    drop.addEventListener("click", () => picker.click());
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        picker.click();
      }
    });
    picker.addEventListener("change", () => {
      if (picker.files[0]) handleFile(picker.files[0]);
    });

    $("copy").addEventListener("click", async () => {
      const out = $("output");
      if (!out.value) return;
      try {
        await navigator.clipboard.writeText(out.value);
        setStatus("Copied to clipboard.", "ok");
      } catch {
        out.select(); // fallback for restrictive clipboard policies
        setStatus("Press Ctrl+C to copy the selected text.", "busy");
      }
    });

    $("clear").addEventListener("click", () => {
      $("output").value = "";
      setStatus("");
    });
  }

  document.addEventListener("DOMContentLoaded", wire);
})();
