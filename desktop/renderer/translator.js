// Marshal Translator — renderer UI controller (single-panel, no tabs)

const api = window.marshalTranslator;

// ── State ──
let targetLang = "uk";
let currentTranslation = "";
let historyItems = [];       // cached list of HistoryItem, most recent first
let historyIndex = -1;       // cursor into historyItems when navigating with ↑/↓

// ── Appearance sync ──
// The main window owns the appearance choice (light / dark / system) and
// stores it in the shared default session's localStorage. The translator just
// mirrors it — apply on load, on focus (in case we missed a storage event),
// and whenever the key changes via `storage` / BroadcastChannel.

const APPEARANCE_VALUES = ["light", "dark", "system"];

function currentAppearance() {
  const raw = localStorage.getItem("marshal-appearance");
  return APPEARANCE_VALUES.includes(raw) ? raw : "system";
}

function applyAppearance(value) {
  const next = APPEARANCE_VALUES.includes(value) ? value : "system";
  const root = document.documentElement;
  if (next === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", next);
}

applyAppearance(currentAppearance());

window.addEventListener("storage", (e) => {
  if (e.key === "marshal-appearance") applyAppearance(e.newValue);
});
window.addEventListener("focus", () => applyAppearance(currentAppearance()));

if (typeof BroadcastChannel !== "undefined") {
  const channel = new BroadcastChannel("marshal-appearance");
  channel.addEventListener("message", (event) => {
    if (event.data?.appearance) applyAppearance(event.data.appearance);
  });
}

// Render all [data-icon] placeholders once the script loads.
window.MarshalIcons?.apply();

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
  btnHistory: document.getElementById("btn-history"),
  fileInput: document.getElementById("file-input"),
  // History panel
  historyPanel: document.getElementById("history-panel"),
  historyList: document.getElementById("history-list"),
  historyClear: document.getElementById("history-clear"),
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

// ── ⌘↵ in textarea → translate, ↑/↓ on empty input → history recall ──
dom.inputText.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    triggerTextTranslate();
    return;
  }
  // Only hijack arrow keys when the textarea has no text — otherwise they are
  // standard caret navigation.
  if (dom.inputText.value === "" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    if (historyItems.length === 0) return;
    e.preventDefault();
    if (e.key === "ArrowUp") {
      historyIndex = Math.min(historyIndex + 1, historyItems.length - 1);
      applyHistoryItem(historyItems[historyIndex]);
    } else {
      historyIndex = Math.max(historyIndex - 1, -1);
      if (historyIndex === -1) {
        clearInputAndResult();
      } else {
        applyHistoryItem(historyItems[historyIndex]);
      }
    }
  }
});

function applyHistoryItem(item) {
  if (!item) return;
  if (item.mode === "text") {
    dom.inputText.value = item.text;
    dom.btnTranslate.disabled = !item.text.trim();
  } else {
    dom.inputText.value = "";
    dom.btnTranslate.disabled = true;
  }
  currentTranslation = item.translation;
  dom.resultText.textContent = item.translation;
  const src = (item.sourceLang || "").toUpperCase();
  const tgt = (item.targetLang || "").toUpperCase();
  dom.langBadge.textContent = src ? `${src} → ${tgt}` : `→ ${tgt}`;
  dom.resultLabel.textContent = item.mode === "image"
    ? `📷 OCR · → ${tgt}`
    : `Translation · ${src || "?"} → ${tgt}`;
  setState("result");
}

function clearInputAndResult() {
  dom.inputText.value = "";
  dom.btnTranslate.disabled = true;
  currentTranslation = "";
  dom.resultText.textContent = "";
  dom.langBadge.textContent = "";
  dom.resultLabel.textContent = "Translation";
  setState("empty");
}

// ── Paste ──
dom.btnPaste.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) {
      dom.inputText.value = text;
      dom.btnTranslate.disabled = false;
      dom.inputText.focus();
      triggerTextTranslate();
    }
  } catch {
    dom.inputText.focus();
  }
});

// ── Auto-translate on Cmd+V paste into textarea ──
dom.inputText.addEventListener("paste", () => {
  // Wait for the browser to commit the pasted text, then fire the translation.
  queueMicrotask(() => {
    if (dom.inputText.value.trim()) triggerTextTranslate();
  });
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
const defaultCopyHTML = dom.copyBtn.innerHTML;
dom.copyBtn.addEventListener("click", () => {
  if (!currentTranslation) return;
  navigator.clipboard.writeText(currentTranslation).then(() => {
    const checkSvg = window.MarshalIcons?.render("check", { size: 12 }) ?? "";
    dom.copyBtn.innerHTML = `${checkSvg}<span>Copied!</span>`;
    dom.copyBtn.classList.add("copied");
    setTimeout(() => {
      dom.copyBtn.innerHTML = defaultCopyHTML;
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

// ── History panel ──

dom.btnHistory?.addEventListener("click", async (e) => {
  e.stopPropagation();
  const visible = dom.historyPanel.style.display !== "none";
  if (visible) {
    dom.historyPanel.style.display = "none";
  } else {
    await refreshHistory();
    renderHistoryPanel();
    dom.historyPanel.style.display = "flex";
  }
});

document.addEventListener("click", (e) => {
  if (
    dom.historyPanel.style.display !== "none" &&
    !dom.historyPanel.contains(e.target) &&
    e.target !== dom.btnHistory
  ) {
    dom.historyPanel.style.display = "none";
  }
});

dom.historyClear?.addEventListener("click", async () => {
  historyItems = await api.clearHistory();
  historyIndex = -1;
  renderHistoryPanel();
});

async function refreshHistory() {
  try {
    historyItems = (await api.listHistory()) || [];
  } catch {
    historyItems = [];
  }
}

function renderHistoryPanel() {
  dom.historyList.innerHTML = "";
  if (historyItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No translations yet. Use ⌘⌥T or capture a region to start.";
    dom.historyList.appendChild(empty);
    return;
  }
  historyItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "history-item";

    const lang = document.createElement("div");
    lang.className = "history-item-lang";
    const src = (item.sourceLang || "").toUpperCase();
    const tgt = (item.targetLang || "").toUpperCase();
    lang.textContent = item.mode === "image"
      ? `📷 → ${tgt}`
      : `${src || "?"} → ${tgt}`;

    const txt = document.createElement("div");
    txt.className = "history-item-text";
    txt.textContent = item.mode === "image"
      ? item.translation
      : (item.text || item.translation);

    row.appendChild(lang);
    row.appendChild(txt);
    row.addEventListener("click", () => {
      applyHistoryItem(item);
      dom.historyPanel.style.display = "none";
    });
    dom.historyList.appendChild(row);
  });
}

// Keep the cached history list fresh after every IPC result so ↑/↓ navigation
// sees the newest entry without having to open the dropdown.
const originalOnResult = api.onResult;
if (originalOnResult) {
  api.onResult(async () => {
    await refreshHistory();
    historyIndex = -1;
  });
}

// Initialize
setState("empty");
void refreshHistory();
requestAnimationFrame(() => dom.inputText.focus());
