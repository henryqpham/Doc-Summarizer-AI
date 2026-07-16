// Front-end: drag a file -> POST raw bytes to the local server -> show summary.
// The file never goes anywhere except 127.0.0.1; the local server forwards it.
(function () {
  const $ = (id) => document.getElementById(id);
  let busy = false;

  function setStatus(msg, kind) {
    const el = $("status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " status--" + kind : "");
  }

  async function handleFile(file) {
    if (busy) return; // in-flight lock: a second drop would race the first
    busy = true;
    $("dropzone").classList.add("dropzone--busy");
    try {
      setStatus(`Summarizing "${file.name}"… this can take a moment.`, "busy");

      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-filename": encodeURIComponent(file.name),
        },
        body: file,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      $("output").value = data.summary;
      setStatus(`Done — review, then copy. (${data.chars.toLocaleString()} characters read)`, "ok");
    } catch (err) {
      setStatus(err.message || String(err), "error");
    } finally {
      busy = false;
      $("dropzone").classList.remove("dropzone--busy");
    }
  }

  function wire() {
    const drop = $("dropzone");
    const picker = $("filepicker");

    ["dragenter", "dragover"].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        if (!busy) drop.classList.add("dropzone--over");
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
    drop.addEventListener("click", () => !busy && picker.click());
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!busy) picker.click();
      }
    });
    picker.addEventListener("change", () => {
      if (picker.files[0]) handleFile(picker.files[0]);
      picker.value = ""; // let the same file be re-picked
    });

    $("copy").addEventListener("click", async () => {
      const out = $("output");
      if (!out.value) return;
      try {
        await navigator.clipboard.writeText(out.value);
        setStatus("Copied to clipboard.", "ok");
      } catch {
        out.select();
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
