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
  const updatingEl = document.getElementById("updating");

  function render(update) {
    overlay.dataset.status = update.status;
    hintEl.textContent = update.hint || "";
    hintEl.title = update.hint || "";
    document.body.classList.toggle("interactive", Boolean(update.interactive));

    // summaryHtml is produced by renderSummaryHtml() in the main process,
    // which escapes the model output before adding its <strong>/<li> tags.
    summaryEl.innerHTML = update.summaryHtml || "";
    summaryEl.classList.toggle("streaming", Boolean(update.summaryStreaming));
    // Stale: the bullets predate the latest transcript; keep them readable
    // but say a replacement is on its way.
    summaryEl.classList.toggle("stale", Boolean(update.summaryStale));
    updatingEl.hidden = !update.summaryStale;

    const finals = update.captions || [];
    const translations = update.translations || [];
    const lines = finals.map((text, index) => {
      const latest = index === finals.length - 1;
      const translation = translations[index] || "";
      const line = document.createElement("div");
      line.className = latest ? "line latest" : "line";
      // Translated lines (#210) show the translation as the caption. The
      // original stays under the latest one only — names and terms are
      // checked against what was just said, not against lines from a
      // minute ago — and until the translation lands the original stands
      // in, muted, rather than leaving a gap.
      if (translation) {
        line.classList.add("translated");
        const main = document.createElement("span");
        main.className = "translation";
        main.textContent = translation;
        line.appendChild(main);
        if (latest) {
          const original = document.createElement("span");
          original.className = "original";
          original.textContent = text;
          line.appendChild(original);
        }
      } else {
        line.textContent = text;
      }
      return line;
    });
    // The utterance still being spoken (#203). Its newest words are at the
    // end, so it overflows to the left — an end ellipsis would hide exactly
    // the part the user is waiting for.
    if (update.partial) {
      const line = document.createElement("div");
      line.className = "line partial";
      const text = document.createElement("span");
      text.textContent = update.partial;
      line.appendChild(text);
      lines.push(line);
    }
    captionsEl.replaceChildren(...lines);
    // Fade the cut edge only when there is a cut: on a short line the mask
    // would dim the first letters for no reason.
    const partialLine = captionsEl.querySelector(".line.partial");
    if (partialLine) {
      partialLine.classList.toggle("overflowing", partialLine.firstChild.offsetWidth > partialLine.clientWidth);
    }
  }

  if (api && typeof api.onUpdate === "function") {
    api.onUpdate((_event, update) => render(update));
  }

  stopBtn.addEventListener("click", () => {
    if (api && typeof api.stop === "function") api.stop();
  });
})();
