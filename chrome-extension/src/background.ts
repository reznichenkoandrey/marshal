const BRIDGE_PORT = Number("__MARSHAL_BRIDGE_PORT__");
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
};

chrome.runtime.onInstalled.addListener(() => {
  void ensureClientId();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureClientId();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
  await postJson("/session/hello", {
    clientId,
    tabId,
    url: state.url,
    title: state.title,
    state: state.state
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
