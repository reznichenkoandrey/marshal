// Marshal Translator — renderer UI controller (single-panel, no tabs)

const api = window.marshalTranslator;

// ── State ──
let targetLang = "uk";
let currentTranslation = "";

// ── DOM refs ──
const dom = {
  langBtns: document.querySelectorAll(".lang-btn"),
  closeBtn: document.getElementById("close-btn"),
  // Input
  inputText: document.getElementById("input-text"),
  btnPaste: document.getElementById("btn-paste"),
  btnClear: document.getElementById("btn-clear"),
  btnTranslate: document.getElementById("btn-translate"),
  // Header actions
  btnCapture: document.getElementById("btn-capture"),
  btnUpload: document.getElementById("btn-upload"),
  fileInput: document.getElementById("file-input"),
  // Result
  resultLabel: document.getElementById("result-label"),
  resultText: document.getElementById("result-text"),
  stateLoading: document.getElementById("state-loading"),
  stateEmpty: document.getElementById("state-empty"),
  errorMsg: document.getElementById("error-msg"),
  // Footer
  langBadge: document.getElementById("lang-badge"),
  copyBtn: document.getElementById("copy-btn")
};

// ── Language toggle ──
dom.langBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    targetLang = btn.dataset.lang;
    dom.langBtns.forEach((b) => b.classList.toggle("active", b.dataset.lang === targetLang));
  });
});

// ── Close ──
dom.closeBtn.addEventListener("click", () => api.close());
document.addEventListener("keydown", (e) => { if (e.key === "Escape") api.close(); });

// ── Input: enable/disable translate button ──
dom.inputText.addEventListener("input", () => {
  dom.btnTranslate.disabled = !dom.inputText.value.trim();
});

// ── ⌘↵ in textarea → translate ──
dom.inputText.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    triggerTextTranslate();
  }
});

// ── Paste ──
dom.btnPaste.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) {
      dom.inputText.value = text;
      dom.btnTranslate.disabled = false;
      dom.inputText.focus();
    }
  } catch {
    dom.inputText.focus();
  }
});

// ── Clear ──
dom.btnClear.addEventListener("click", () => {
  dom.inputText.value = "";
  dom.btnTranslate.disabled = true;
  dom.inputText.focus();
  currentTranslation = "";
  dom.langBadge.textContent = "";
  dom.resultLabel.textContent = "Translation";
  setState("empty");
});

// ── Translate button ──
dom.btnTranslate.addEventListener("click", triggerTextTranslate);

function triggerTextTranslate() {
  const text = dom.inputText.value.trim();
  if (!text) return;
  setState("loading");
  api.translateText(text, targetLang);
}

// ── Screen capture ──
dom.btnCapture.addEventListener("click", async () => {
  dom.btnCapture.disabled = true;
  try {
    setState("loading");
    const base64 = await api.captureScreen();
    if (!base64) {
      setState("empty");
      return;
    }
    // Translation will arrive via onResult IPC event
    await api.translateImage(base64, "image/png", targetLang);
  } catch (err) {
    showError(err?.message || "Capture failed");
  } finally {
    dom.btnCapture.disabled = false;
  }
});

// ── Upload image ──
dom.btnUpload.addEventListener("click", () => dom.fileInput.click());

dom.fileInput.addEventListener("change", () => {
  const file = dom.fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    const mimeType = file.type || "image/png";
    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");
    setState("loading");
    dom.resultLabel.textContent = `Image · ${file.name}`;
    try {
      await api.translateImage(base64, mimeType, targetLang);
    } catch (err) {
      showError(err?.message || "Translation failed");
    }
  };
  reader.readAsDataURL(file);
  dom.fileInput.value = "";
});

// ── Copy ──
dom.copyBtn.addEventListener("click", () => {
  if (!currentTranslation) return;
  navigator.clipboard.writeText(currentTranslation).then(() => {
    dom.copyBtn.textContent = "Copied!";
    dom.copyBtn.classList.add("copied");
    setTimeout(() => {
      dom.copyBtn.textContent = "Copy";
      dom.copyBtn.classList.remove("copied");
    }, 1500);
  });
});

// ── IPC events from main process ──

api.onLoading((_, { mode }) => {
  if (mode === "image") {
    dom.inputText.value = "";
    dom.btnTranslate.disabled = true;
    dom.resultLabel.textContent = "📷 Translating image…";
  }
  setState("loading");
});

api.onResult((_, data) => {
  currentTranslation = data.translation || "";

  if (data.mode === "text") {
    // Fill input with source text if triggered from clipboard (input may be empty)
    if (data.text && !dom.inputText.value.trim()) {
      dom.inputText.value = data.text;
      dom.btnTranslate.disabled = false;
    }
    const srcLang = (data.sourceLang || "?").toUpperCase();
    const tgtLang = data.targetLang.toUpperCase();
    dom.resultLabel.textContent = `Translation · ${srcLang} → ${tgtLang}`;
    dom.langBadge.textContent = `${srcLang} → ${tgtLang}`;
  } else {
    // Image/OCR result
    dom.resultLabel.textContent = `📷 OCR Translation · → ${data.targetLang ? data.targetLang.toUpperCase() : ""}`;
    dom.langBadge.textContent = `Image → ${data.targetLang ? data.targetLang.toUpperCase() : ""}`;
  }

  dom.resultText.textContent = currentTranslation;
  setState("result");
});

api.onError((_, { message }) => {
  showError(message);
});

// ── Auto-focus input on window focus ──
window.addEventListener("focus", () => {
  requestAnimationFrame(() => dom.inputText.focus());
});

// ── Helpers ──

function setState(state) {
  dom.stateLoading.style.display = state === "loading" ? "flex" : "none";
  dom.stateEmpty.style.display = state === "empty" ? "flex" : "none";
  dom.resultText.style.display = state === "result" ? "block" : "none";
  dom.errorMsg.style.display = "none";
}

function showError(msg) {
  dom.errorMsg.textContent = `⚠ ${msg}`;
  dom.errorMsg.style.display = "block";
  dom.stateLoading.style.display = "none";
  dom.stateEmpty.style.display = "none";
  dom.resultText.style.display = "none";
}

// Initialize
setState("empty");
requestAnimationFrame(() => dom.inputText.focus());
