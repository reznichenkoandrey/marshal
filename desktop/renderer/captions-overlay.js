// desktop/renderer/captions-overlay.js
//
// Dumb view for the captions overlay. Main owns every decision — what the
// captions are, what the summary looks like (it arrives pre-rendered and
// escaped), whether the window accepts the mouse — and this file only paints.

(() => {
  const api = window.marshalCaptions;
  const overlay = document.getElementById("overlay");
  const hintEl = document.getElementById("hint");
  const summaryEl = document.getElementById("summary");
  const captionsEl = document.getElementById("captions");
  const stopBtn = document.getElementById("stop");

  function render(update) {
    overlay.dataset.status = update.status;
    hintEl.textContent = update.hint || "";
    hintEl.title = update.hint || "";
    document.body.classList.toggle("interactive", Boolean(update.interactive));

    // summaryHtml is produced by renderSummaryHtml() in the main process,
    // which escapes the model output before adding its <strong>/<li> tags.
    summaryEl.innerHTML = update.summaryHtml || "";
    summaryEl.classList.toggle("streaming", Boolean(update.summaryStreaming));

    captionsEl.replaceChildren(
      ...(update.captions || []).map((text) => {
        const line = document.createElement("div");
        line.className = "line";
        line.textContent = text;
        return line;
      })
    );
  }

  if (api && typeof api.onUpdate === "function") {
    api.onUpdate((_event, update) => render(update));
  }

  stopBtn.addEventListener("click", () => {
    if (api && typeof api.stop === "function") api.stop();
  });
})();
