// Marshal side panel — own chat UI backed by the desktop `/chat` endpoint
// (LocalBridgeServer → ClaudeCliBridge). No iframe, no DOM scraping of
// third-party providers. See issue #56.

const BRIDGE_PORT = 3210;
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const SESSION_STORAGE_KEY = "marshalChatSessionId";
const PROVIDER_STORAGE_KEY = "marshalChatProvider";
const APPEARANCE_STORAGE_KEY = "marshalAppearance";
const DEFAULT_PROVIDER = "claude-cli";
const REQUEST_TIMEOUT_MS = 300_000;

type Appearance = "light" | "dark" | "system";
const APPEARANCES: readonly Appearance[] = ["light", "dark", "system"];

// Icons helper is exposed on window by icons.js (loaded before this script).
declare global {
  interface Window {
    MarshalIcons?: {
      render: (name: string, options?: { size?: number; strokeWidth?: number; className?: string }) => string;
      apply: (root?: Document | HTMLElement) => void;
      paths: Record<string, string>;
    };
  }
}

type Role = "user" | "assistant" | "system";

interface ChatMessage {
  role: Role;
  text: string;
  timestamp: number;
}

interface CapturedContext {
  kind: "text" | "html";
  payload: string;
  sourceUrl: string;
}

// -- DOM refs --
const providerSelect = document.getElementById("providerSelect") as HTMLSelectElement;
const resetBtn = document.getElementById("resetBtn") as HTMLButtonElement;
const themeBtn = document.getElementById("themeBtn") as HTMLButtonElement;
const promptInput = document.getElementById("promptInput") as HTMLTextAreaElement;
const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const captureTextBtn = document.getElementById("captureTextBtn") as HTMLButtonElement;
const captureHtmlBtn = document.getElementById("captureHtmlBtn") as HTMLButtonElement;
const cancelPickerBtn = document.getElementById("cancelPickerBtn") as HTMLButtonElement;
const statusText = document.getElementById("statusText") as HTMLDivElement;
const messageList = document.getElementById("messageList") as HTMLDivElement;
const contextChip = document.getElementById("contextChip") as HTMLDivElement;
const contextPreview = document.getElementById("contextPreview") as HTMLSpanElement;
const clearContextBtn = document.getElementById("clearContextBtn") as HTMLButtonElement;

let sessionId = "";
let provider = DEFAULT_PROVIDER;
let appearance: Appearance = "system";
let pickerActive = false;
let pendingContext: CapturedContext | null = null;
let currentAbort: AbortController | null = null;

void init();

async function init(): Promise<void> {
  // Render all [data-icon] placeholders in the static HTML before wiring up
  // events so the DOM has its final shape.
  window.MarshalIcons?.apply();

  sessionId = await ensureSessionId();
  provider = await loadProvider();
  providerSelect.value = provider;

  appearance = await loadAppearance();
  applyAppearance(appearance);

  bindEvents();
  renderWelcome();
  void pingBridge();
}

async function loadAppearance(): Promise<Appearance> {
  const stored = await chrome.storage.local.get(APPEARANCE_STORAGE_KEY);
  const value = stored[APPEARANCE_STORAGE_KEY];
  return typeof value === "string" && (APPEARANCES as readonly string[]).includes(value)
    ? (value as Appearance)
    : "system";
}

async function saveAppearance(value: Appearance): Promise<void> {
  await chrome.storage.local.set({ [APPEARANCE_STORAGE_KEY]: value });
}

function applyAppearance(value: Appearance): void {
  const root = document.documentElement;
  if (value === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", value);
  refreshThemeBtnIcon();
}

function refreshThemeBtnIcon(): void {
  if (!themeBtn || !window.MarshalIcons) return;
  const name = appearance === "light" ? "sun" : appearance === "dark" ? "moon" : "monitor";
  themeBtn.innerHTML = window.MarshalIcons.render(name, { size: 14 });
  themeBtn.title = `Appearance: ${appearance} (click to cycle)`;
}

async function cycleAppearance(): Promise<void> {
  const idx = APPEARANCES.indexOf(appearance);
  appearance = APPEARANCES[(idx + 1) % APPEARANCES.length];
  await saveAppearance(appearance);
  applyAppearance(appearance);
}

async function loadProvider(): Promise<string> {
  const stored = await chrome.storage.local.get(PROVIDER_STORAGE_KEY);
  const value = stored[PROVIDER_STORAGE_KEY];
  return typeof value === "string" && value.length > 0 ? value : DEFAULT_PROVIDER;
}

async function saveProvider(value: string): Promise<void> {
  await chrome.storage.local.set({ [PROVIDER_STORAGE_KEY]: value });
}

function bindEvents(): void {
  sendBtn.addEventListener("click", () => void handleSend());
  stopBtn.addEventListener("click", () => handleStop());
  resetBtn.addEventListener("click", () => void handleReset());
  themeBtn.addEventListener("click", () => void cycleAppearance());
  captureTextBtn.addEventListener("click", () => void startCapture("text"));
  captureHtmlBtn.addEventListener("click", () => void startCapture("html"));
  cancelPickerBtn.addEventListener("click", () => void cancelPicker());
  clearContextBtn.addEventListener("click", () => clearContext());
  providerSelect.addEventListener("change", () => void handleProviderChange());
  promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  });
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
}

async function handleProviderChange(): Promise<void> {
  provider = providerSelect.value;
  await saveProvider(provider);
  appendMessage({
    role: "system",
    text: `Switched to ${providerSelect.options[providerSelect.selectedIndex]?.text ?? provider}. Previous conversation was kept per-provider — will continue where you left off on this backend.`,
    timestamp: Date.now()
  });
  setStatus(`Provider: ${provider}`, "info");
  setTimeout(() => setStatus(""), 2000);
}

async function ensureSessionId(): Promise<string> {
  const stored = await chrome.storage.local.get(SESSION_STORAGE_KEY);
  const existing = stored[SESSION_STORAGE_KEY];
  if (typeof existing === "string" && existing.length > 0) return existing;
  const generated = `panel-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: generated });
  return generated;
}

function renderWelcome(): void {
  const providerLabel = providerSelect.options[providerSelect.selectedIndex]?.text ?? provider;
  appendMessage({
    role: "system",
    text: `Marshal chat — using ${providerLabel}. Pick an element on the page or just type a question.`,
    timestamp: Date.now()
  });
}

async function pingBridge(): Promise<void> {
  try {
    const r = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`health returned ${r.status}`);
    setStatus("Connected to desktop bridge.", "success");
    setTimeout(() => setStatus(""), 2500);
  } catch {
    setStatus("Desktop bridge offline — start Marshal with `npm run desktop`.", "error");
  }
}

// ============================================================
// Send / Chat
// ============================================================

async function handleSend(): Promise<void> {
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  const pageInfo = await getActivePageInfo();
  const contextBlock = buildContextBlock(pageInfo);
  const displayContext = pendingContext ? ` (with picked ${pendingContext.kind})` : "";

  appendMessage({ role: "user", text: prompt + displayContext, timestamp: Date.now() });
  promptInput.value = "";
  clearContext();
  setSendingUI(true);
  setStatus("Claude is thinking…", "info");

  const assistantEntry = appendMessage({ role: "assistant", text: "…", timestamp: Date.now() });

  const abort = new AbortController();
  currentAbort = abort;
  const timeoutHandle = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${BRIDGE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, context: contextBlock, sessionId, provider }),
      signal: abort.signal
    });

    const payload = (await response.json()) as { ok: boolean; data?: { text: string }; error?: string };
    if (!payload.ok) {
      assistantEntry.text = `Error: ${payload.error ?? "unknown"}`;
      assistantEntry.role = "system";
      rerenderMessage(assistantEntry);
      setStatus(payload.error ?? "Request failed.", "error");
      return;
    }

    assistantEntry.text = payload.data?.text ?? "";
    rerenderMessage(assistantEntry);
    setStatus("", undefined);
  } catch (error: unknown) {
    const message = error instanceof Error
      ? (error.name === "AbortError" ? "Aborted." : error.message)
      : "Unknown error.";
    assistantEntry.text = `Error: ${message}`;
    assistantEntry.role = "system";
    rerenderMessage(assistantEntry);
    setStatus(message, "error");
  } finally {
    clearTimeout(timeoutHandle);
    currentAbort = null;
    setSendingUI(false);
  }
}

function handleStop(): void {
  currentAbort?.abort();
  setStatus("Stopped.", "info");
}

async function handleReset(): Promise<void> {
  messageList.innerHTML = "";
  clearContext();
  try {
    await fetch(`${BRIDGE_URL}/chat/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
    renderWelcome();
    setStatus("Conversation reset.", "success");
    setTimeout(() => setStatus(""), 1500);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Reset failed.", "error");
  }
}

function buildContextBlock(pageInfo: { url: string; title: string }): string {
  const sections: string[] = [];

  if (pageInfo.url && pageInfo.url !== "about:blank") {
    sections.push(`Current page: ${pageInfo.title || "(no title)"}\nURL: ${pageInfo.url}`);
  }

  if (pendingContext) {
    const header = pendingContext.kind === "html" ? "Picked HTML element" : "Picked text";
    sections.push(
      [`--- ${header} from ${pendingContext.sourceUrl} ---`, pendingContext.payload, "--- end context ---"].join("\n")
    );
  }

  return sections.join("\n\n");
}

async function getActivePageInfo(): Promise<{ url: string; title: string }> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { url: tab?.url ?? "", title: tab?.title ?? "" };
  } catch {
    return { url: "", title: "" };
  }
}

// ============================================================
// Element picker
// ============================================================

async function startCapture(outputType: "text" | "html"): Promise<void> {
  if (pickerActive) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("No active tab found.", "error");
    return;
  }

  pickerActive = true;
  setCaptureUI(true);
  setStatus("Click an element on the page…", "info");

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/picker/element-picker.js"]
    });
    await chrome.tabs.sendMessage(tab.id, { type: "marshal-start-picker", outputType });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Picker injection failed.";
    setStatus(message, "error");
    pickerActive = false;
    setCaptureUI(false);
  }
}

async function cancelPicker(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.tabs.sendMessage(tab.id, { type: "marshal-cancel-picker" }).catch(() => undefined);
  }
  pickerActive = false;
  setCaptureUI(false);
  setStatus("");
}

function handleBackgroundMessage(message: Record<string, unknown>): void {
  if (message?.type === "marshal-picker-result" && pickerActive) {
    pickerActive = false;
    setCaptureUI(false);
    const payload = String(message.payload ?? "");
    const sourceUrl = String(message.sourceUrl ?? "");
    if (!payload) {
      setStatus("Nothing captured.", "error");
      return;
    }
    attachContext(payload, sourceUrl);
  }

  if (message?.type === "marshal-picker-cancelled") {
    pickerActive = false;
    setCaptureUI(false);
    setStatus("");
  }
}

function attachContext(payload: string, sourceUrl: string): void {
  const looksLikeHtml = /^\s*<[a-zA-Z!]/.test(payload.slice(0, 32));
  pendingContext = {
    kind: looksLikeHtml ? "html" : "text",
    payload,
    sourceUrl: sourceUrl || "unknown page"
  };
  contextPreview.textContent = payload.slice(0, 120).replace(/\s+/g, " ").trim() + (payload.length > 120 ? "…" : "");
  contextChip.hidden = false;
  setStatus("Element captured — ask a question and press Ask Claude.", "success");
  promptInput.focus();
}

function clearContext(): void {
  pendingContext = null;
  contextChip.hidden = true;
  contextPreview.textContent = "";
}

// ============================================================
// Rendering
// ============================================================

function appendMessage(message: ChatMessage): ChatMessage {
  const entry = { ...message };
  const el = document.createElement("div");
  el.className = `message message-${entry.role}`;
  el.dataset.ts = String(entry.timestamp);
  renderInto(el, entry.text);
  messageList.appendChild(el);
  messageList.scrollTop = messageList.scrollHeight;
  return entry;
}

function rerenderMessage(entry: ChatMessage): void {
  const el = messageList.querySelector<HTMLDivElement>(`[data-ts="${entry.timestamp}"]`);
  if (!el) return;
  el.className = `message message-${entry.role}`;
  renderInto(el, entry.text);
  messageList.scrollTop = messageList.scrollHeight;
}

function renderInto(el: HTMLDivElement, text: string): void {
  el.textContent = text;
}

// ============================================================
// UI state helpers
// ============================================================

function setSendingUI(sending: boolean): void {
  sendBtn.hidden = sending;
  stopBtn.hidden = !sending;
  promptInput.disabled = sending;
  captureTextBtn.disabled = sending;
  captureHtmlBtn.disabled = sending;
}

function setCaptureUI(active: boolean): void {
  captureTextBtn.hidden = active;
  captureHtmlBtn.hidden = active;
  cancelPickerBtn.hidden = !active;
}

function setStatus(message: string, level?: "success" | "error" | "info"): void {
  statusText.textContent = message;
  statusText.className = level ?? "";
}
