// `__MARSHAL_BRIDGE_PORT__` is substituted by scripts/postbuild.mjs using
// CHATGPT_EXTENSION_BRIDGE_PORT (default 3210). If substitution ever fails the
// literal placeholder survives and `Number(...)` would yield NaN, silently
// breaking every bridge request. Validate and fall back loudly.
const DEFAULT_BRIDGE_PORT = 3210;
const RAW_BRIDGE_PORT = "__MARSHAL_BRIDGE_PORT__";
const parsedBridgePort = /^\d+$/u.test(RAW_BRIDGE_PORT) ? Number(RAW_BRIDGE_PORT) : NaN;
const BRIDGE_PORT = Number.isInteger(parsedBridgePort) && parsedBridgePort > 0 && parsedBridgePort < 65536
  ? parsedBridgePort
  : DEFAULT_BRIDGE_PORT;

if (BRIDGE_PORT === DEFAULT_BRIDGE_PORT && !/^\d+$/u.test(RAW_BRIDGE_PORT)) {
  console.error(
    `[Marshal] BRIDGE_PORT placeholder was not substituted (got "${RAW_BRIDGE_PORT}"). ` +
    `Falling back to ${DEFAULT_BRIDGE_PORT}. Re-run the build via scripts/postbuild.mjs.`
  );
}

const CLIENT_ID_KEY = "marshalClientId";

type BridgeCommand = {
  id: string;
  kind: "send_prompt" | "reset_conversation" | "debug_snapshot";
  payload: Record<string, unknown>;
};

type TickState = {
  url: string;
  title: string;
  state: string;
  visibilityState?: string;
  hasFocus?: boolean;
};

chrome.runtime.onInstalled.addListener(() => {
  void ensureClientId();
  void configureSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureClientId();
  void configureSidePanel();
});

// -- Side Panel setup --

async function configureSidePanel(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // sidePanel API not available — ignore
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id) {
    void chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
  }
});

// -- Port-based message broker between sidepanel and injector --
// sidepanel and injector cannot communicate directly via postMessage
// because Chrome doesn't inject content scripts into iframes inside extension pages.
// Both connect to background via chrome.runtime.connect and background relays messages.

let injectorPort: chrome.runtime.Port | null = null;
let sidepanelPort: chrome.runtime.Port | null = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "marshal-injector") {
    injectorPort = port;
    port.onMessage.addListener((msg) => {
      // Relay injector → sidepanel
      sidepanelPort?.postMessage(msg);
    });
    port.onDisconnect.addListener(() => { injectorPort = null; });
  }

  if (port.name === "marshal-sidepanel") {
    sidepanelPort = port;
    port.onMessage.addListener((msg) => {
      // Relay sidepanel → injector
      injectorPort?.postMessage(msg);
    });
    port.onDisconnect.addListener(() => { sidepanelPort = null; });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Relay picker / page-capture results from content script to sidepanel
  if (
    message?.type === "marshal-picker-result" ||
    message?.type === "marshal-picker-cancelled" ||
    message?.type === "marshal-page-capture-result"
  ) {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
    sendResponse({ ok: true });
    return;
  }

  // Screenshot capture — only service worker has access to captureVisibleTab
  if (message?.type === "marshal-capture-screenshot") {
    chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
      sendResponse({ screenshot: dataUrl ?? "" });
    });
    return true;
  }

  if (message?.type !== "marshal-tick" || !sender.tab?.id) {
    return;
  }

  void handleTick(sender.tab.id, message.state as TickState)
    .then(() => sendResponse({ ok: true }))
    .catch((error: unknown) => {
      const text = error instanceof Error ? error.message : "Unknown background error.";
      sendResponse({ ok: false, error: text });
    });

  return true;
});

async function handleTick(tabId: number, state: TickState): Promise<void> {
  const clientId = await ensureClientId();
  const tab = await chrome.tabs.get(tabId);
  await postJson("/session/hello", {
    clientId,
    tabId,
    url: state.url,
    title: state.title,
    state: state.state,
    visibilityState: state.visibilityState,
    hasFocus: state.hasFocus,
    activeTab: Boolean(tab.active)
  }).catch(() => undefined);

  const next = await fetchJson<{ ok: boolean; command: BridgeCommand | null }>(
    `/command/next?clientId=${encodeURIComponent(clientId)}&tabId=${encodeURIComponent(String(tabId))}`
  ).catch(() => ({ ok: false, command: null }));

  if (!next.ok || !next.command) {
    return;
  }

  try {
    const result = (await chrome.tabs.sendMessage(tabId, {
      type: "marshal-command",
      command: next.command
    })) as { ok: boolean; data?: Record<string, unknown>; error?: string };

    await postJson("/command/result", {
      clientId,
      tabId,
      commandId: next.command.id,
      ok: result?.ok ?? false,
      data: result?.data ?? {},
      error: result?.error
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to deliver command to ChatGPT tab.";
    await postJson("/command/result", {
      clientId,
      tabId,
      commandId: next.command.id,
      ok: false,
      error: message
    }).catch(() => undefined);
  }
}

async function ensureClientId(): Promise<string> {
  const stored = await chrome.storage.local.get(CLIENT_ID_KEY);
  const existing = stored[CLIENT_ID_KEY];
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }

  const clientId = crypto.randomUUID();
  await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId });
  return clientId;
}

async function fetchJson<T>(pathname: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${pathname}`);
  if (!response.ok) {
    throw new Error(`Bridge request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function postJson(pathname: string, payload: object): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Bridge POST failed: ${response.status}`);
  }
}
