const PROVIDERS = [
  { id: "chatgpt", name: "OpenAI ChatGPT", url: "https://chatgpt.com/" },
  { id: "claude", name: "Anthropic Claude", url: "https://claude.ai/" },
  { id: "gemini", name: "Google Gemini", url: "https://gemini.google.com/" }
] as const;

type ProviderId = (typeof PROVIDERS)[number]["id"];

// Message actions moved to port-based communication (see sendToInjector/waitForInjector)

const STORAGE_KEY = "marshalSelectedProvider";
const IFRAME_LOAD_TIMEOUT_MS = 5000;
const AGENT_MAX_STEPS = 15;
const RESPONSE_TIMEOUT_MS = 90000;

// -- DOM refs --
const providerSelect = document.getElementById("providerSelect") as HTMLSelectElement;
const reloadBtn = document.getElementById("reloadBtn") as HTMLButtonElement;
const openExternalLink = document.getElementById("openExternalLink") as HTMLAnchorElement;
const promptInput = document.getElementById("promptInput") as HTMLTextAreaElement;
const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
const agentBtn = document.getElementById("agentBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const captureTextBtn = document.getElementById("captureTextBtn") as HTMLButtonElement;
const captureHtmlBtn = document.getElementById("captureHtmlBtn") as HTMLButtonElement;
const cancelPickerBtn = document.getElementById("cancelPickerBtn") as HTMLButtonElement;
const statusText = document.getElementById("statusText") as HTMLDivElement;
const stepLog = document.getElementById("stepLog") as HTMLDivElement;
// Loading overlay removed — iframe shows its own UI
const providerFrame = document.getElementById("providerFrame") as HTMLIFrameElement;

let activeProviderId: ProviderId = "chatgpt";
let pickerActive = false;
let agentRunning = false;
let agentAborted = false;

// -- Types --

interface PageState {
  url: string;
  title: string;
  visibleText: string;
  elements: ElementInfo[];
  screenshot?: string;
}

interface ElementInfo {
  index: number;
  tag: string;
  role: string;
  text: string;
  selector: string;
  type: string;
  href: string;
  placeholder: string;
  value: string;
}

interface AgentAction {
  action: "click" | "type" | "scroll" | "navigate" | "wait" | "done";
  selector?: string;
  text?: string;
  url?: string;
  direction?: string;
  ms?: number;
  result?: string;
  reason?: string;
}

interface StepRecord {
  step: number;
  action: AgentAction;
  result: string;
}

// ============================================================
// Init
// ============================================================

void init();

async function init(): Promise<void> {
  populateProviderSelect();

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const savedId = stored[STORAGE_KEY] as string | undefined;
  const validProvider = PROVIDERS.find((p) => p.id === savedId);
  activeProviderId = validProvider ? validProvider.id : "chatgpt";
  providerSelect.value = activeProviderId;

  loadProvider(activeProviderId);
  bindEvents();
}

function populateProviderSelect(): void {
  for (const provider of PROVIDERS) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    providerSelect.appendChild(option);
  }
}

function bindEvents(): void {
  providerSelect.addEventListener("change", () => loadProvider(providerSelect.value as ProviderId));
  reloadBtn.addEventListener("click", () => reloadCurrentProvider());
  sendBtn.addEventListener("click", () => void handleSidebarSend());
  agentBtn.addEventListener("click", () => void handleAgentStart());
  stopBtn.addEventListener("click", () => handleAgentStop());
  captureTextBtn.addEventListener("click", () => void startCapture("text"));
  captureHtmlBtn.addEventListener("click", () => void startCapture("html"));
  cancelPickerBtn.addEventListener("click", () => void cancelPicker());

  // Enter key in prompt (Shift+Enter for newline)
  promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSidebarSend();
    }
  });

  // Listen for picker results relayed from background
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
}

// ============================================================
// Provider loading
// ============================================================

function loadProvider(providerId: ProviderId): void {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return;

  activeProviderId = providerId;
  void chrome.storage.local.set({ [STORAGE_KEY]: providerId });
  document.body.setAttribute("data-provider", providerId);
  openExternalLink.href = provider.url;

  providerFrame.src = provider.url;
  setStatus("");
}

function reloadCurrentProvider(): void {
  loadProvider(activeProviderId);
}

// ============================================================
// Sidebar Mode — send question with page context
// ============================================================

async function handleSidebarSend(): Promise<void> {
  const question = promptInput.value.trim();
  if (!question) return;

  setButtonsDisabled(true);
  setStatus("Capturing page context\u2026", "info");

  try {
    const pageState = await capturePageState();
    const prompt = buildSidebarPrompt(pageState, question);

    setStatus("Sending to AI\u2026", "info");
    const sendOk = await sendPromptToIframe(prompt, pageState.screenshot);

    if (!sendOk) {
      setStatus("Failed to send to AI. Try again.", "error");
      setButtonsDisabled(false);
      return;
    }

    // Wait for AI to start generating before polling for response
    await sleep(2000);
    setStatus("Waiting for response\u2026", "info");
    const response = await readResponseFromIframe(RESPONSE_TIMEOUT_MS);

    if (response) {
      setStatus("Response received.", "success");
      showStepLog(true);
      clearStepLog();
      appendStep(formatResult(response), "done");
      promptInput.value = "";
    } else {
      setStatus("No response received (check the chat).", "error");
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed";
    setStatus(msg, "error");
  } finally {
    setButtonsDisabled(false);
  }
}

// ============================================================
// Agent Mode — autonomous loop
// ============================================================

async function handleAgentStart(): Promise<void> {
  const task = promptInput.value.trim();
  if (!task) return;

  agentRunning = true;
  agentAborted = false;
  setAgentUI(true);
  clearStepLog();
  showStepLog(true);
  appendStep("Task: " + task, "info");

  const history: StepRecord[] = [];
  let lastActionSig = "";
  let repeatCount = 0;

  try {
    for (let step = 0; step < AGENT_MAX_STEPS; step++) {
      if (agentAborted) { appendStep("Stopped by user.", "error"); break; }

      // 1. Capture current page
      setStatus(`Step ${step + 1}: capturing page\u2026`, "info");
      const pageState = await capturePageState();

      // 2. Smart skip: if AI asked to navigate to a URL we're already on, auto-resolve
      if (history.length > 0) {
        const lastAction = history[history.length - 1].action;
        if (lastAction.action === "navigate" && lastAction.url) {
          const targetHost = safeHostname(lastAction.url);
          const currentHost = safeHostname(pageState.url);
          if (targetHost === currentHost && pageState.url.includes(lastAction.url.split("/").pop() ?? "___")) {
            // Navigation succeeded — record it and continue to next AI call
            history[history.length - 1].result = `Already on ${pageState.url}`;
          }
        }
      }

      // 3. Build prompt and send to AI
      const prompt = buildAgentPrompt(task, pageState, history);
      setStatus(`Step ${step + 1}: thinking\u2026`, "info");
      const sendOk = await sendPromptToIframe(prompt, pageState.screenshot);
      if (agentAborted) break;
      if (!sendOk) { appendStep(`Step ${step + 1}: Failed to send to AI.`, "error"); break; }

      // 4. Read AI response
      await sleep(2000);
      setStatus(`Step ${step + 1}: reading AI response\u2026`, "info");
      const responseText = await readResponseFromIframe(RESPONSE_TIMEOUT_MS);
      if (!responseText) { appendStep(`Step ${step + 1}: No response from AI.`, "error"); break; }

      // 5. Parse action
      const action = parseAction(responseText);

      // 6. Done?
      if (action.action === "done") {
        appendStep(formatResult(action.result ?? "Done."), "done");
        break;
      }

      // 7. Anti-loop
      const sig = `${action.action}|${action.selector ?? ""}|${action.url ?? ""}|${action.direction ?? ""}`;
      if (sig === lastActionSig) {
        repeatCount++;
        if (repeatCount >= 2) {
          // Force done — ask AI to summarize what it sees
          appendStep("Agent repeated same action. Forcing summary\u2026", "info");
          const forceDonePrompt = `You already tried "${action.action}" twice and it didn't work. Based on what you see on the page, give your best answer now.\n\nTASK: ${task}\n\nPage text:\n${pageState.visibleText.slice(0, 5000)}\n\nRespond with: {"action":"done","result":"your answer"}`;
          await sendPromptToIframe(forceDonePrompt);
          await sleep(2000);
          const forceResponse = await readResponseFromIframe(RESPONSE_TIMEOUT_MS);
          if (forceResponse) {
            const forceAction = parseAction(forceResponse);
            appendStep(formatResult(forceAction.result ?? forceResponse), "done");
          } else {
            appendStep("Could not get AI response.", "error");
          }
          break;
        }
      } else {
        repeatCount = 0;
        lastActionSig = sig;
      }

      // 8. Log
      appendStep(`Step ${step + 1}: ${action.reason ?? action.action}`, "running");

      // 9. Execute — but skip navigate if already on that URL
      let actionResult: string;
      if (action.action === "navigate" && action.url && pageState.url.includes(action.url.replace(/\/$/, "").split("/").pop() ?? "___")) {
        actionResult = `Already on this page (${pageState.url})`;
        // Override action to prevent loop — inject "you're already there" into history
        action.action = "done" as AgentAction["action"];
        // Re-ask AI with context that we're already there
        appendStep("Already on the requested page. Asking AI to analyze\u2026", "info");
        const alreadyTherePrompt = `You are ALREADY on the page: ${pageState.url}\nTitle: ${pageState.title}\n\nPage content:\n${pageState.visibleText.slice(0, 8000)}\n\nTASK: ${task}\n\nAnalyze the visible data and respond with: {"action":"done","result":"your detailed human-readable answer"}`;
        await sendPromptToIframe(alreadyTherePrompt);
        await sleep(2000);
        const finalResponse = await readResponseFromIframe(RESPONSE_TIMEOUT_MS);
        if (finalResponse) {
          const finalAction = parseAction(finalResponse);
          appendStep(formatResult(finalAction.result ?? finalResponse), "done");
        }
        break;
      } else {
        actionResult = await executeActionOnPage(action);
      }

      // 10. Record and wait
      history.push({ step, action, result: actionResult });
      const isNav = action.action === "click" || action.action === "navigate";
      await sleep(isNav ? 3000 : 1000);
    }
  } catch (error: unknown) {
    appendStep("Error: " + (error instanceof Error ? error.message : "Unknown"), "error");
  } finally {
    agentRunning = false;
    setAgentUI(false);
    setStatus("Agent finished.", "success");
  }
}

function handleAgentStop(): void {
  agentAborted = true;
  setStatus("Stopping agent\u2026", "info");
}

// ============================================================
// Page capture
// ============================================================

async function capturePageState(): Promise<PageState> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  // Capture screenshot via background
  const screenshotPromise = new Promise<string>((resolve) => {
    chrome.runtime.sendMessage({ type: "marshal-capture-screenshot" }, (response) => {
      resolve(response?.screenshot ?? "");
    });
  });

  // Capture DOM via injected script
  const capturePromise = new Promise<PageState>((resolve) => {
    const listener = (message: { type: string; payload: PageState }): void => {
      if (message?.type === "marshal-page-capture-result") {
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message.payload);
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ["src/agent/page-capture.js"]
    }).catch(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve({ url: tab.url ?? "", title: tab.title ?? "", visibleText: "", elements: [] });
    });

    // Timeout
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve({ url: tab.url ?? "", title: tab.title ?? "", visibleText: "", elements: [] });
    }, 5000);
  });

  const [screenshot, pageData] = await Promise.all([screenshotPromise, capturePromise]);
  return { ...pageData, screenshot };
}

// ============================================================
// Communication with AI iframe (via postMessage → injector)
// ============================================================

// -- Port-based communication with injector via background broker --

const injectorPort = chrome.runtime.connect({ name: "marshal-sidepanel" });
const pendingCallbacks = new Map<string, (data: Record<string, unknown>) => void>();

injectorPort.onMessage.addListener((msg: Record<string, unknown>) => {
  const action = msg.action as string;
  const cb = pendingCallbacks.get(action);
  if (cb) {
    pendingCallbacks.delete(action);
    cb(msg);
  }
});

function sendToInjector(data: Record<string, unknown>): void {
  try { injectorPort.postMessage(data); } catch { /* port disconnected */ }
}

function waitForInjector(action: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCallbacks.delete(action);
      resolve(null);
    }, timeoutMs);

    pendingCallbacks.set(action, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function sendPromptToIframe(text: string, screenshot?: string): Promise<boolean> {
  const promise = waitForInjector("marshal:sendComplete", 20000);
  sendToInjector({ action: "marshal:sendPrompt", text, screenshot });
  return promise.then((r) => r?.success === true);
}

function readResponseFromIframe(timeoutMs: number): Promise<string | null> {
  const promise = waitForInjector("marshal:responseReady", timeoutMs + 5000);
  sendToInjector({ action: "marshal:readResponse", timeoutMs });
  return promise.then((r) => r?.success ? (r.text as string) : null);
}

// ============================================================
// Action execution on target page
// ============================================================

async function executeActionOnPage(action: AgentAction): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return "No active tab";

  // Handle navigate separately — it changes the page
  if (action.action === "navigate" && action.url) {
    await chrome.tabs.update(tab.id, { url: action.url });
    await sleep(3000); // Wait for navigation
    return `Navigated to ${action.url}`;
  }

  // Inject action executor and send the action
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ["src/agent/action-executor.js"]
    }).then(() => {
      chrome.tabs.sendMessage(tab.id!, { type: "marshal-execute-action", action }, (response) => {
        if (chrome.runtime.lastError) {
          resolve("Action execution failed: " + chrome.runtime.lastError.message);
          return;
        }
        resolve(response?.result ?? "Action executed.");
      });
    }).catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : "Injection failed";
      resolve(msg);
    });
  });
}

// ============================================================
// Prompt builders (inline to avoid import issues with content scripts)
// ============================================================

function buildSidebarPrompt(pageState: PageState, question: string): string {
  return [
    `Page URL: ${pageState.url}`,
    `Page Title: ${pageState.title}`,
    "",
    "Page Content:",
    pageState.visibleText.slice(0, 15000),
    "",
    `User Question: ${question}`
  ].join("\n");
}

function buildAgentPrompt(task: string, pageState: PageState, history: StepRecord[]): string {
  const lines: string[] = [];

  lines.push("Browser agent. ONE JSON action per response. No text/markdown outside JSON.");
  lines.push("");
  lines.push("RULES:");
  lines.push("- Look at the URL to know which page you are on. Do NOT navigate to a page you are already on.");
  lines.push("- If previous step returned 'Element not found', try a different selector or use navigate with the URL instead.");
  lines.push("- Use navigate with full URL instead of click when you know the target URL.");
  lines.push("- Do NOT scroll more than 2 times. If you scrolled and still don't see data, use done with what you have.");
  lines.push("- When you have enough info, use done IMMEDIATELY.");
  lines.push("- The done result MUST be clean human-readable text with line breaks. NOT JSON.");
  lines.push("");
  lines.push("Actions:");
  lines.push('{"action":"click","selector":"CSS","reason":"..."}');
  lines.push('{"action":"type","selector":"CSS","text":"...","reason":"..."}');
  lines.push('{"action":"scroll","direction":"down","reason":"..."}');
  lines.push('{"action":"navigate","url":"https://...","reason":"..."}');
  lines.push('{"action":"wait","ms":2000,"reason":"..."}');
  lines.push('{"action":"done","result":"Human readable answer here"}');
  lines.push("");
  lines.push(`PAGE: ${pageState.url}`);
  lines.push(`TITLE: ${pageState.title}`);

  if (pageState.elements.length > 0) {
    lines.push("");
    lines.push("Interactive elements:");
    for (const el of pageState.elements) {
      const parts = [`[${el.index}]`, el.tag];
      if (el.role) parts.push(`role="${el.role}"`);
      if (el.text) parts.push(`"${el.text}"`);
      if (el.type) parts.push(`type=${el.type}`);
      if (el.href) parts.push(`href=${el.href.slice(0, 80)}`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      parts.push(`-> ${el.selector}`);
      lines.push(parts.join(" "));
    }
  }

  // Shorter visible text for agent mode (save tokens)
  const textSlice = pageState.visibleText.slice(0, 5000);
  if (textSlice) {
    lines.push("");
    lines.push("Page text:");
    lines.push(textSlice);
  }

  lines.push("");
  lines.push("TASK: " + task);

  if (history.length > 0) {
    lines.push("");
    lines.push("PREVIOUS ACTIONS AND RESULTS:");
    for (const s of history.slice(-3)) {
      const desc = s.action.reason ?? `${s.action.action} ${s.action.selector ?? s.action.url ?? ""}`;
      lines.push(`- ${desc} => ${s.result}`);
    }
  }

  lines.push("");
  lines.push("YOUR ACTION (JSON only):");
  return lines.join("\n");
}

function parseAction(responseText: string): AgentAction {
  // Try inline JSON
  const jsonMatch = responseText.match(/\{[^{}]*"action"\s*:\s*"[^"]+[^{}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as AgentAction;
      if (parsed.action) return parsed;
    } catch { /* fallthrough */ }
  }

  // Try code block
  const codeBlockMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]) as AgentAction;
      if (parsed.action) return parsed;
    } catch { /* fallthrough */ }
  }

  // Fallback: entire response is the answer
  return { action: "done", result: responseText.trim(), reason: "No parseable action" };
}

// ============================================================
// Element picker (legacy capture mode)
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
  setStatus("Click an element on the page\u2026");

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/picker/element-picker.js"]
    });
    await chrome.tabs.sendMessage(tab.id, { type: "marshal-start-picker", outputType });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Picker injection failed.";
    setStatus(msg, "error");
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

// ============================================================
// Message handlers
// ============================================================

function handleBackgroundMessage(message: Record<string, unknown>): void {
  if (message?.type === "marshal-picker-result" && pickerActive) {
    pickerActive = false;
    setCaptureUI(false);
    const captured = String(message.payload ?? "");
    if (!captured) {
      setStatus("Nothing captured.", "error");
      return;
    }
    setStatus("Pasting into chat\u2026");
    void pasteToIframe(captured);
  }

  if (message?.type === "marshal-picker-cancelled") {
    pickerActive = false;
    setCaptureUI(false);
    setStatus("");
  }

  if (message?.type === "marshal-page-capture-result") {
    // Handled in capturePageState promise
  }
}

function pasteToIframe(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const promise = waitForInjector("marshal:pasteToChatResult", 5000);
    sendToInjector({ action: "marshal:pasteToChat", text });
    promise.then((r) => {
      if (r?.success) {
        setStatus("Pasted into chat.", "success");
        resolve(true);
      } else {
        fallbackCopy(text);
        resolve(false);
      }
    });
  });
}

function fallbackCopy(text: string): void {
  void navigator.clipboard.writeText(text).then(
    () => setStatus("Copied to clipboard. Press Ctrl+V.", "success"),
    () => setStatus("Auto-paste failed.", "error")
  );
}

// ============================================================
// UI helpers
// ============================================================

function setCaptureUI(active: boolean): void {
  captureTextBtn.hidden = active;
  captureHtmlBtn.hidden = active;
  cancelPickerBtn.hidden = !active;
}

function setAgentUI(running: boolean): void {
  sendBtn.hidden = running;
  agentBtn.hidden = running;
  stopBtn.hidden = !running;
  promptInput.disabled = running;
}

function setButtonsDisabled(disabled: boolean): void {
  sendBtn.disabled = disabled;
  agentBtn.disabled = disabled;
  promptInput.disabled = disabled;
}

function setStatus(message: string, level?: "success" | "error" | "info"): void {
  statusText.textContent = message;
  statusText.className = level ?? "";
}

// showLoading removed — no loading overlay

function showStepLog(visible: boolean): void {
  stepLog.hidden = !visible;
}

function clearStepLog(): void {
  stepLog.innerHTML = "";
}

function appendStep(text: string, level: "running" | "done" | "error" | "info"): void {
  const entry = document.createElement("div");
  entry.className = `step-entry ${level}`;
  // Support line breaks in results
  entry.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
  stepLog.appendChild(entry);
  stepLog.scrollTop = stepLog.scrollHeight;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatResult(raw: string): string {
  // Replace literal \n with real newlines, clean up JSON artifacts
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "  ")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function safeHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
