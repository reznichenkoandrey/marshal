// Background service worker.
// Relays picker results from content script → side panel. All chat traffic
// now goes directly from the side panel to the desktop `/chat` endpoint,
// so no HTTP bridge polling happens here anymore.

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
});
