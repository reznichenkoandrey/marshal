// Background service worker.
// Relays picker results from content script → side panel. All chat traffic
// now goes directly from the side panel to the desktop `/chat` endpoint,
// so no HTTP bridge polling happens here anymore.

const BRIDGE_PORT = 3210;
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const DEBUGGER_PROTOCOL_VERSION = "1.3";

chrome.runtime.onInstalled.addListener(() => {
  void configureSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanel();
});

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.type === "marshal-picker-result" ||
    message?.type === "marshal-picker-cancelled"
  ) {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "marshal-fullpage-capture") {
    // sendResponse is async — keep the message channel open and reply with
    // the captured PNG (or an error) once the debugger round-trip finishes.
    void captureFullPage()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }
});

interface FullPageResult {
  ok: boolean;
  error?: string;
  savedPath?: string;
  bytes?: number;
}

/**
 * Capture the active tab as a single PNG that includes content below the fold.
 * Uses `chrome.debugger` + DevTools `Page.captureScreenshot` with
 * `captureBeyondViewport: true` — this is the same primitive DevTools uses
 * for "Capture full size screenshot" and works on every site without needing
 * to scroll-and-stitch by hand.
 *
 * Pushes the PNG to the desktop bridge at `/capture/fullpage`, which writes
 * it to the user-configured capture folder. Returns the saved path so the
 * sidepanel can show a confirmation toast.
 */
async function captureFullPage(): Promise<FullPageResult> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) {
    return { ok: false, error: "No active tab to capture." };
  }
  const tabId = activeTab.id;
  const target: chrome.debugger.Debuggee = { tabId };

  // chrome:// and chrome-extension:// pages cannot be attached to. Catch the
  // attach error early so the user sees a useful message.
  try {
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
  } catch (err) {
    return {
      ok: false,
      error: `Cannot attach debugger to this tab (${(err as Error).message}). chrome:// and Web Store pages are blocked by Chrome.`
    };
  }

  try {
    const shot = (await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      fromSurface: true
    })) as { data: string } | undefined;

    if (!shot?.data) {
      return { ok: false, error: "Debugger returned no screenshot payload." };
    }

    const desktopResult = await postToBridge(activeTab, shot.data);
    return desktopResult;
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {
      // Detach is best-effort — Chrome detaches on tab navigation anyway.
    }
  }
}

async function postToBridge(
  tab: chrome.tabs.Tab,
  base64Png: string
): Promise<FullPageResult> {
  const payload = {
    base64: base64Png,
    url: tab.url ?? "",
    title: tab.title ?? "",
    capturedAt: Date.now()
  };

  let response: Response;
  try {
    response = await fetch(`${BRIDGE_URL}/capture/fullpage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return {
      ok: false,
      error: `Desktop bridge unreachable on ${BRIDGE_URL}. Is Marshal running? (${(err as Error).message})`
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, error: `Desktop bridge rejected capture (${response.status}): ${text}` };
  }

  const body = (await response.json().catch(() => null)) as
    | { ok: boolean; savedPath?: string; bytes?: number; error?: string }
    | null;
  if (!body?.ok) {
    return { ok: false, error: body?.error ?? "Desktop bridge returned non-ok payload." };
  }

  return { ok: true, savedPath: body.savedPath, bytes: body.bytes };
}
