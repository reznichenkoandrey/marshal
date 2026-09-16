// Marshal Translator — renderer UI controller.
//
// Two panes, source on the left and translation on the right, a language pair
// with auto-detect and swap, and translation that fires while you type. The
// renderer owns its own loading/result state: `api.translateText` resolves
// with the result, and every request carries a sequence number so a slow
// answer to an older keystroke can never overwrite a newer one.
//
// The main process still pushes results for the flows it starts itself —
// the double-⌘C hotkey, ⌘⌥T and the ⌘⇧2 OCR capture — via onLoading /
// onResult / onError.

const api = window.marshalTranslator;

// Translate-as-you-type: long enough that a normal typing burst produces one
// request, short enough that a pause feels immediate.
const DEBOUNCE_MS = 650;
// A translation is only worth remembering once the user stops changing it.
const HISTORY_COMMIT_MS = 2500;
const MAX_CHARS = 5000;
const AUTO_LABEL = "Detect language";
const FORMALITY_CYCLE = ["default", "formal", "informal"];
const FORMALITY_LABELS = { default: "Neutral", formal: "Formal", informal: "Informal" };

// ── State ──
let languages = [];
let sourceLang = "auto";
let targetLang = "uk";
let formality = "default";
let pinned = false;
let currentTranslation = "";
// Last detected source language, needed to swap out of "Detect language".
let detectedSourceLang = "";
// Guards against re-translating text that is already on screen.
let lastRequest = { text: "", sourceLang: "", targetLang: "", formality: "" };
let requestSeq = 0;
let debounceTimer = null;
let historyTimer = null;
let historyItems = [];       // cached list of HistoryItem, most recent first
let historyIndex = -1;       // cursor into historyItems when navigating with ↑/↓
let popoverSide = null;      // "source" | "target" | null
let popoverFocus = -1;

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
  // Header
  btnPin: document.getElementById("btn-pin"),
  btnHistory: document.getElementById("btn-history"),
  btnCapture: document.getElementById("btn-capture"),
  btnUpload: document.getElementById("btn-upload"),
  fileInput: document.getElementById("file-input"),
  closeBtn: document.getElementById("close-btn"),
  // Language bar
  srcLang: document.getElementById("src-lang"),
  srcLangLabel: document.getElementById("src-lang-label"),
  srcLangDetected: document.getElementById("src-lang-detected"),
  tgtLang: document.getElementById("tgt-lang"),
  tgtLangLabel: document.getElementById("tgt-lang-label"),
  btnSwap: document.getElementById("btn-swap"),
  btnFormality: document.getElementById("btn-formality"),
  formalityLabel: document.getElementById("formality-label"),
  // Source pane
  inputText: document.getElementById("input-text"),
  charCount: document.getElementById("char-count"),
  btnPaste: document.getElementById("btn-paste"),
  btnClear: document.getElementById("btn-clear"),
  // Target pane
  resultText: document.getElementById("result-text"),
  stateLoading: document.getElementById("state-loading"),
  stateEmpty: document.getElementById("state-empty"),
  errorMsg: document.getElementById("error-msg"),
  noticeMsg: document.getElementById("notice-msg"),
  langBadge: document.getElementById("lang-badge"),
  btnInsert: document.getElementById("btn-insert"),
  copyBtn: document.getElementById("copy-btn"),
  // Popovers
  langPopover: document.getElementById("lang-popover"),
  langFilter: document.getElementById("lang-filter"),
  langOptions: document.getElementById("lang-options"),
  historyPanel: document.getElementById("history-panel"),
  historyList: document.getElementById("history-list"),
  historyClear: document.getElementById("history-clear")
};

// ── Language helpers ──

function languageName(code) {
  if (code === "auto") return AUTO_LABEL;
  return languages.find((entry) => entry.code === code)?.name ?? String(code || "").toUpperCase();
}

function renderLanguageBar() {
  dom.srcLangLabel.textContent = languageName(sourceLang);
  dom.srcLangDetected.textContent =
    sourceLang === "auto" && detectedSourceLang ? `· ${languageName(detectedSourceLang)}` : "";
  dom.tgtLangLabel.textContent = languageName(targetLang);
  // Swapping out of auto-detect needs a concrete language to swap to.
  dom.btnSwap.disabled = sourceLang === "auto" && !detectedSourceLang;
  dom.formalityLabel.textContent = FORMALITY_LABELS[formality];
  dom.btnFormality.classList.toggle("active", formality !== "default");
}

async function persistPair() {
  try {
    await api.setPair({ sourceLang, targetLang, formality });
  } catch {
    // Non-fatal: the UI keeps working with the in-memory pair, only the
    // hotkey direction and the next window open lose the update.
  }
}

// ── Language popover ──

function openLangPopover(side) {
  popoverSide = side;
  popoverFocus = -1;
  dom.langFilter.value = "";
  renderLangOptions();
  dom.langPopover.hidden = false;
  positionPopover(side === "source" ? dom.srcLang : dom.tgtLang);
  (side === "source" ? dom.srcLang : dom.tgtLang).setAttribute("aria-expanded", "true");
  dom.langFilter.focus();
}

function closeLangPopover() {
  popoverSide = null;
  dom.langPopover.hidden = true;
  dom.srcLang.setAttribute("aria-expanded", "false");
  dom.tgtLang.setAttribute("aria-expanded", "false");
}

function positionPopover(anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = dom.langPopover.offsetWidth;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  dom.langPopover.style.left = `${Math.round(left)}px`;
  dom.langPopover.style.top = `${Math.round(rect.bottom + 4)}px`;
}

function visibleLangOptions() {
  const query = dom.langFilter.value.trim().toLowerCase();
  const entries = languages.filter(
    (entry) =>
      !query ||
      entry.name.toLowerCase().includes(query) ||
      entry.native.toLowerCase().includes(query) ||
      entry.code.startsWith(query)
  );
  // Only the source side can defer to detection.
  if (popoverSide === "source" && (!query || AUTO_LABEL.toLowerCase().includes(query))) {
    return [{ code: "auto", name: AUTO_LABEL, native: "" }, ...entries];
  }
  return entries;
}

function renderLangOptions() {
  const entries = visibleLangOptions();
  const selected = popoverSide === "source" ? sourceLang : targetLang;
  dom.langOptions.innerHTML = "";

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "lang-option-empty";
    empty.textContent = "No language matches";
    dom.langOptions.appendChild(empty);
    return;
  }

  entries.forEach((entry, index) => {
    const option = document.createElement("button");
    option.className = "lang-option";
    option.type = "button";
    option.setAttribute("role", "option");
    if (entry.code === selected) {
      option.classList.add("selected");
      option.setAttribute("aria-selected", "true");
    }
    if (index === popoverFocus) option.classList.add("focused");

    const name = document.createElement("span");
    name.textContent = entry.name;
    option.appendChild(name);

    if (entry.native && entry.native !== entry.name) {
      const native = document.createElement("span");
      native.className = "lang-option-native";
      native.textContent = entry.native;
      option.appendChild(native);
    }

    option.addEventListener("click", () => selectLanguage(entry.code));
    dom.langOptions.appendChild(option);
  });

  const focused = dom.langOptions.children[popoverFocus];
  focused?.scrollIntoView({ block: "nearest" });
}

function selectLanguage(code) {
  if (popoverSide === "source") {
    // Picking the target language as the source would translate into itself.
    if (code === targetLang) targetLang = sourceLang === "auto" ? detectedSourceLang || "en" : sourceLang;
    sourceLang = code;
  } else {
    if (code === sourceLang) sourceLang = "auto";
    targetLang = code;
  }
  closeLangPopover();
  renderLanguageBar();
  void persistPair();
  translateNow();
  dom.inputText.focus();
}

dom.srcLang.addEventListener("click", (e) => {
  e.stopPropagation();
  if (popoverSide === "source") closeLangPopover();
  else openLangPopover("source");
});

dom.tgtLang.addEventListener("click", (e) => {
  e.stopPropagation();
  if (popoverSide === "target") closeLangPopover();
  else openLangPopover("target");
});

dom.langFilter.addEventListener("input", () => {
  popoverFocus = -1;
  renderLangOptions();
});

dom.langFilter.addEventListener("keydown", (e) => {
  const count = visibleLangOptions().length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    popoverFocus = count === 0 ? -1 : (popoverFocus + 1) % count;
    renderLangOptions();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    popoverFocus = count === 0 ? -1 : (popoverFocus - 1 + count) % count;
    renderLangOptions();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const entries = visibleLangOptions();
    const pick = entries[popoverFocus >= 0 ? popoverFocus : 0];
    if (pick) selectLanguage(pick.code);
  }
});

// ── Swap ──
// Mirrors DeepL: the translation moves into the source box, so the swap is a
// continuation of the same thought rather than a reset.
dom.btnSwap.addEventListener("click", () => {
  const nextTarget = sourceLang === "auto" ? detectedSourceLang : sourceLang;
  if (!nextTarget) return;

  sourceLang = targetLang;
  targetLang = nextTarget;
  detectedSourceLang = "";

  if (currentTranslation) {
    dom.inputText.value = currentTranslation;
    updateCharCount();
  }

  dom.btnSwap.classList.add("spin");
  setTimeout(() => dom.btnSwap.classList.remove("spin"), 200);

  renderLanguageBar();
  void persistPair();
  translateNow();
});

// ── Formality ──
dom.btnFormality.addEventListener("click", () => {
  const next = (FORMALITY_CYCLE.indexOf(formality) + 1) % FORMALITY_CYCLE.length;
  formality = FORMALITY_CYCLE[next];
  renderLanguageBar();
  void persistPair();
  translateNow();
});

// ── Pin ──
dom.btnPin.addEventListener("click", async () => {
  try {
    pinned = await api.setPinned(!pinned);
  } catch {
    pinned = !pinned;
  }
  dom.btnPin.setAttribute("aria-pressed", pinned ? "true" : "false");
  dom.btnPin.title = pinned ? "Unpin — hide when focus leaves (⌘P)" : "Keep window open (⌘P)";
});

// ── Close ──
dom.closeBtn.addEventListener("click", () => api.close());

// ── Input ──

function updateCharCount() {
  const length = dom.inputText.value.length;
  dom.charCount.textContent = length === 0 ? "" : `${length} / ${MAX_CHARS}`;
  dom.charCount.classList.toggle("over", length > MAX_CHARS);
}

dom.inputText.addEventListener("input", () => {
  updateCharCount();
  scheduleTranslate();
});

// A paste is a complete thought — translate it without waiting out the
// debounce the way a keystroke would.
dom.inputText.addEventListener("paste", () => {
  queueMicrotask(() => {
    updateCharCount();
    translateNow();
  });
});

dom.inputText.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    translateNow();
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
      if (historyIndex === -1) clearAll();
      else applyHistoryItem(historyItems[historyIndex]);
    }
  }
});

dom.btnPaste.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) {
      dom.inputText.value = text;
      updateCharCount();
      translateNow();
    }
  } catch {
    // Clipboard read denied — nothing to paste, just put the caret back.
  }
  dom.inputText.focus();
});

dom.btnClear.addEventListener("click", () => {
  clearAll();
  dom.inputText.focus();
});

function clearAll() {
  cancelTimers();
  dom.inputText.value = "";
  updateCharCount();
  currentTranslation = "";
  detectedSourceLang = "";
  lastRequest = { text: "", sourceLang: "", targetLang: "", formality: "" };
  dom.resultText.textContent = "";
  dom.langBadge.textContent = "";
  setResultActions(false);
  renderLanguageBar();
  setState("empty");
}

// ── Translation ──

function cancelTimers() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
  }
}

function scheduleTranslate() {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runTranslate();
  }, DEBOUNCE_MS);
}

function translateNow() {
  cancelTimers();
  void runTranslate();
}

async function runTranslate() {
  const text = dom.inputText.value.trim();

  if (!text) {
    currentTranslation = "";
    dom.resultText.textContent = "";
    dom.langBadge.textContent = "";
    setResultActions(false);
    setState("empty");
    return;
  }

  if (text.length > MAX_CHARS) {
    showError(`Text is ${text.length} characters — the limit is ${MAX_CHARS}.`);
    return;
  }

  // Same text, same pair, same register — the answer is already on screen.
  if (
    text === lastRequest.text &&
    sourceLang === lastRequest.sourceLang &&
    targetLang === lastRequest.targetLang &&
    formality === lastRequest.formality &&
    currentTranslation
  ) {
    return;
  }

  const seq = ++requestSeq;
  setState("loading");

  try {
    const result = await api.translateText(text, { sourceLang, targetLang, formality });
    if (seq !== requestSeq) return; // a newer keystroke already took over
    lastRequest = { text, sourceLang, targetLang, formality };
    applyResult({ ...result, text, mode: "text" });
    scheduleHistoryCommit({ ...result, text, mode: "text" });
  } catch (err) {
    if (seq !== requestSeq) return;
    showError(err?.message || "Translation failed");
  }
}

/** Renders a finished translation into the target pane. */
function applyResult(result) {
  currentTranslation = result.translation || "";
  dom.resultText.textContent = currentTranslation;

  if (result.mode === "image") {
    detectedSourceLang = "";
    dom.langBadge.textContent = `Image → ${languageName(result.targetLang)}`;
  } else {
    const detected = typeof result.sourceLang === "string" ? result.sourceLang : "";
    detectedSourceLang = detected && detected !== "auto" ? detected : "";
    const from = detectedSourceLang ? languageName(detectedSourceLang) : AUTO_LABEL;
    dom.langBadge.textContent = `${from} → ${languageName(result.targetLang)}`;
  }

  renderLanguageBar();
  setResultActions(!!currentTranslation);
  setState(currentTranslation ? "result" : "empty");
}

/**
 * History gets the translation only once the source text settles, otherwise
 * every debounce tick of a sentence being typed would land as its own entry.
 */
function scheduleHistoryCommit(result) {
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    historyTimer = null;
    void commitHistory(result);
  }, HISTORY_COMMIT_MS);
}

async function commitHistory(result) {
  if (!result?.translation) return;
  try {
    historyItems = await api.pushHistory({
      text: result.text || "",
      translation: result.translation,
      sourceLang: result.sourceLang || "",
      targetLang: result.targetLang || targetLang,
      mode: result.mode || "text"
    });
    historyIndex = -1;
  } catch {
    // History is a convenience — a failed write must not break translating.
  }
}

// ── Screen capture ──
dom.btnCapture.addEventListener("click", async () => {
  dom.btnCapture.disabled = true;
  try {
    setState("loading");
    const base64 = await api.captureScreen();
    if (!base64) {
      setState(currentTranslation ? "result" : "empty");
      return;
    }
    const result = await api.translateImage(base64, "image/png", { sourceLang, targetLang, formality });
    requestSeq++; // an OCR result supersedes any pending text translation
    dom.inputText.value = "";
    updateCharCount();
    applyResult({ ...result, mode: "image" });
    await refreshHistory();
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
    const base64 = String(dataUrl).replace(/^data:[^;]+;base64,/, "");
    setState("loading");
    try {
      const result = await api.translateImage(base64, mimeType, { sourceLang, targetLang, formality });
      requestSeq++;
      dom.inputText.value = "";
      updateCharCount();
      applyResult({ ...result, mode: "image" });
      await refreshHistory();
    } catch (err) {
      showError(err?.message || "Translation failed");
    }
  };
  reader.readAsDataURL(file);
  dom.fileInput.value = "";
});

// ── Copy / Insert ──

function setResultActions(enabled) {
  dom.copyBtn.disabled = !enabled;
  dom.btnInsert.disabled = !enabled;
}

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
    flushHistory();
  });
});

dom.btnInsert.addEventListener("click", async () => {
  if (!currentTranslation) return;
  flushHistory();
  dom.btnInsert.disabled = true;
  try {
    const outcome = await api.insertTranslation(currentTranslation);
    if (outcome && outcome.ok === false && outcome.reason === "paste-failed") {
      showError(
        "Could not paste into the other app — the translation is on your clipboard. " +
        "Grant Accessibility to Marshal in System Settings → Privacy & Security."
      );
    }
  } catch (err) {
    showError(err?.message || "Insert failed");
  } finally {
    dom.btnInsert.disabled = !currentTranslation;
  }
});

/** Copy/Insert mean the user is done with this text — remember it now. */
function flushHistory() {
  if (!historyTimer) return;
  clearTimeout(historyTimer);
  historyTimer = null;
  void commitHistory({
    text: lastRequest.text,
    translation: currentTranslation,
    sourceLang: detectedSourceLang,
    targetLang,
    mode: lastRequest.text ? "text" : "image"
  });
}

// ── IPC events from main process (hotkey + OCR flows) ──

api.onLoading((_, { mode }) => {
  requestSeq++; // main-initiated work supersedes anything pending here
  cancelTimers();
  if (mode === "image") {
    dom.inputText.value = "";
    updateCharCount();
  }
  setState("loading");
});

api.onResult((_, data) => {
  requestSeq++;
  cancelTimers();

  if (data.mode === "text" && typeof data.text === "string" && data.text) {
    dom.inputText.value = data.text;
    updateCharCount();
    lastRequest = {
      text: data.text.trim(),
      sourceLang,
      // The hotkey path picks its own direction, so record what actually ran.
      targetLang: data.targetLang || targetLang,
      formality
    };
  }

  // Reflect the direction the hotkey actually used. Not persisted: the flip
  // is a property of that one piece of text, not a new preference.
  if (data.targetLang && data.targetLang !== targetLang) {
    targetLang = data.targetLang;
  }

  applyResult(data);
  void refreshHistory();
});

api.onError((_, { message }) => {
  showError(message);
});

// The service swapped backends because a credential was refused. Informational
// — the translation still arrives, just slower, so this must not clear the
// result or look like a failure. Shown until dismissed; it is not repeated,
// the main process emits it once per session.
api.onNotice?.((_, { message }) => {
  showNotice(message);
});

// ── Global keys ──

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (popoverSide) {
      closeLangPopover();
      dom.inputText.focus();
      return;
    }
    if (!dom.historyPanel.hidden) {
      dom.historyPanel.hidden = true;
      return;
    }
    api.close();
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    if (!dom.btnSwap.disabled) dom.btnSwap.click();
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "v" || e.key === "V")) {
    e.preventDefault();
    if (!dom.btnInsert.disabled) dom.btnInsert.click();
    return;
  }

  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "p" || e.key === "P")) {
    e.preventDefault();
    dom.btnPin.click();
  }
});

// ── Auto-focus input on window focus ──
window.addEventListener("focus", () => {
  requestAnimationFrame(() => dom.inputText.focus());
});

// Keep the popover glued to its anchor when the window is resized.
window.addEventListener("resize", () => {
  if (popoverSide) positionPopover(popoverSide === "source" ? dom.srcLang : dom.tgtLang);
});

// ── Helpers ──

function setState(state) {
  dom.stateLoading.style.display = state === "loading" ? "flex" : "none";
  dom.stateEmpty.style.display = state === "empty" ? "flex" : "none";
  dom.resultText.style.display = state === "result" ? "block" : "none";
  dom.errorMsg.style.display = "none";
}

function showNotice(message) {
  dom.noticeMsg.textContent = "";
  const text = document.createElement("span");
  text.textContent = message;
  const dismiss = document.createElement("button");
  dismiss.className = "notice-dismiss";
  dismiss.title = "Dismiss";
  dismiss.textContent = "✕";
  dismiss.addEventListener("click", () => {
    dom.noticeMsg.hidden = true;
  });
  dom.noticeMsg.appendChild(text);
  dom.noticeMsg.appendChild(dismiss);
  dom.noticeMsg.hidden = false;
}

function showError(msg) {
  dom.errorMsg.textContent = `⚠ ${msg}`;
  dom.errorMsg.style.display = "block";
  dom.stateLoading.style.display = "none";
  dom.stateEmpty.style.display = "none";
  // Keep an existing translation visible — an error on a later keystroke
  // shouldn't blank out the answer the user is reading.
  dom.resultText.style.display = currentTranslation ? "block" : "none";
}

// ── History panel ──

dom.btnHistory.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!dom.historyPanel.hidden) {
    dom.historyPanel.hidden = true;
    return;
  }
  closeLangPopover();
  await refreshHistory();
  renderHistoryPanel();
  dom.historyPanel.hidden = false;
});

document.addEventListener("click", (e) => {
  if (
    !dom.historyPanel.hidden &&
    !dom.historyPanel.contains(e.target) &&
    e.target !== dom.btnHistory
  ) {
    dom.historyPanel.hidden = true;
  }
  if (
    popoverSide &&
    !dom.langPopover.contains(e.target) &&
    !dom.srcLang.contains(e.target) &&
    !dom.tgtLang.contains(e.target)
  ) {
    closeLangPopover();
  }
});

dom.historyClear.addEventListener("click", async () => {
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

function applyHistoryItem(item) {
  if (!item) return;
  cancelTimers();
  requestSeq++;

  dom.inputText.value = item.mode === "text" ? item.text : "";
  updateCharCount();
  if (item.targetLang) targetLang = item.targetLang;
  lastRequest = {
    text: (item.mode === "text" ? item.text : "").trim(),
    sourceLang,
    targetLang,
    formality
  };
  applyResult({
    translation: item.translation,
    sourceLang: item.sourceLang,
    targetLang: item.targetLang || targetLang,
    mode: item.mode
  });
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
    lang.textContent = item.mode === "image" ? `IMAGE → ${tgt}` : `${src || "?"} → ${tgt}`;

    const txt = document.createElement("div");
    txt.className = "history-item-text";
    txt.textContent = item.mode === "image" ? item.translation : item.text || item.translation;

    row.appendChild(lang);
    row.appendChild(txt);
    row.addEventListener("click", () => {
      applyHistoryItem(item);
      dom.historyPanel.hidden = true;
    });
    dom.historyList.appendChild(row);
  });
}

// ── Init ──

async function init() {
  try {
    const config = await api.getLanguages();
    languages = config?.languages ?? [];
    sourceLang = config?.sourceLang ?? "auto";
    targetLang = config?.targetLang ?? "uk";
    formality = config?.formality ?? "default";
    pinned = config?.pinned === true;
  } catch {
    // Without the registry the picker stays empty, but the persisted pair
    // still works — translating must not depend on the popover.
    languages = [];
  }
  dom.btnPin.setAttribute("aria-pressed", pinned ? "true" : "false");
  renderLanguageBar();
  updateCharCount();
  setResultActions(false);
  setState("empty");
  await refreshHistory();
  requestAnimationFrame(() => dom.inputText.focus());
}

void init();
