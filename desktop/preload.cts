const { contextBridge, ipcRenderer } = require("electron");
type IpcRendererEvent = Electron.IpcRendererEvent;
type IpcHandler = (event: IpcRendererEvent, ...args: unknown[]) => void;

// Registry of listeners attached in this renderer so we can both:
//   - expose a disposer to callers (preferred pattern)
//   - fall back to auto-cleanup on window unload for callers that ignore it
// Prevents ipcRenderer listeners from stacking across reloads.
const registeredListeners = new Set<{ channel: string; handler: IpcHandler }>();

function registerListener<T extends unknown[]>(
  channel: string,
  cb: (event: IpcRendererEvent, ...args: T) => void
): () => void {
  const handler: IpcHandler = (event, ...args) => cb(event, ...(args as T));
  ipcRenderer.on(channel, handler);
  const entry = { channel, handler };
  registeredListeners.add(entry);
  return () => {
    if (registeredListeners.delete(entry)) {
      ipcRenderer.removeListener(channel, handler);
    }
  };
}

window.addEventListener("beforeunload", () => {
  for (const { channel, handler } of registeredListeners) {
    ipcRenderer.removeListener(channel, handler);
  }
  registeredListeners.clear();
});

// ── Translator API ──
const translatorApi = {
  translateText: (text: string, targetLang: string) =>
    ipcRenderer.invoke("marshal:translator-translate-text", { text, targetLang }),
  translateImage: (base64: string, mimeType: string, targetLang: string) =>
    ipcRenderer.invoke("marshal:translator-translate-image", { base64, mimeType, targetLang }),
  captureScreen: () => ipcRenderer.invoke("marshal:translator-capture-screen"),
  close: () => ipcRenderer.invoke("marshal:translator-close"),
  // History — list/clear for recalling past translations
  listHistory: () => ipcRenderer.invoke("marshal:translator-history-list"),
  clearHistory: () => ipcRenderer.invoke("marshal:translator-history-clear"),
  // Events from main → renderer. Each `on*` returns a disposer so callers can
  // detach the listener; all listeners are also flushed on `beforeunload`.
  onLoading: (cb: (event: IpcRendererEvent, data: { mode: string }) => void) =>
    registerListener<[{ mode: string }]>("translator-loading", cb),
  onResult: (cb: (event: IpcRendererEvent, data: Record<string, unknown>) => void) =>
    registerListener<[Record<string, unknown>]>("translator-result", cb),
  onError: (cb: (event: IpcRendererEvent, data: { message: string }) => void) =>
    registerListener<[{ message: string }]>("translator-error", cb),
  // Crop overlay. Each overlay gets a unique pair of channels (see
  // desktop/translator/screenshot-service.ts) — renderer receives them via
  // `onCropInit` and echoes them back in `selectCrop` / `cancelCrop`.
  onCropInit: (
    cb: (
      event: IpcRendererEvent,
      payload: { dataUrl?: string; channels?: { select: string; cancel: string } } | string
    ) => void
  ) =>
    registerListener<[
      { dataUrl?: string; channels?: { select: string; cancel: string } } | string
    ]>("crop-init", cb),
  selectCrop: (
    region: { x: number; y: number; width: number; height: number },
    channel = "marshal:crop-selected"
  ) => ipcRenderer.send(channel, region),
  cancelCrop: (channel = "marshal:crop-cancelled") => ipcRenderer.send(channel)
};

contextBridge.exposeInMainWorld("marshalTranslator", translatorApi);

// ── Desktop API ──
const desktopApi = {
  getHealth: () => ipcRenderer.invoke("marshal:get-health"),
  listProjects: () => ipcRenderer.invoke("marshal:list-projects"),
  createProject: (name: string) => ipcRenderer.invoke("marshal:create-project", name),
  listSessions: (projectId?: string) => ipcRenderer.invoke("marshal:list-sessions", projectId),
  createSession: (input?: { title?: string; projectId?: string }) =>
    ipcRenderer.invoke("marshal:create-session", input),
  readSession: (input: { sessionId: string; projectId?: string }) =>
    ipcRenderer.invoke("marshal:read-session", input),
  deleteSession: (input: { sessionId: string; projectId?: string }) =>
    ipcRenderer.invoke("marshal:delete-session", input),
  submitTask: (input: {
    sessionId: string;
    projectId?: string;
    text: string;
    route: string;
    attachments: unknown[];
  }) => ipcRenderer.invoke("marshal:submit-task", input),
  openWorkspace: (input: { sessionId: string; projectId?: string }) =>
    ipcRenderer.invoke("marshal:open-workspace", input),
  selectDirectory: () => ipcRenderer.invoke("marshal:select-directory"),
  restartApp: () => ipcRenderer.invoke("marshal:restart-app"),
  openTranslator: () => ipcRenderer.invoke("marshal:translator-open"),
  getSettings: () => ipcRenderer.invoke("marshal:get-settings"),
  updateSettings: (settings: {
    bridgeMode?: string;
    claudeModel?: string;
    codexModel?: string;
    translatorBackend?: string;
    appearance?: string;
    dictationEnabled?: boolean;
    dictationHotkey?: string;
    dictationBackend?: string;
    dictationLanguage?: string;
    dictationAutoPaste?: boolean;
    dictationPrompt?: string;
  }) => ipcRenderer.invoke("marshal:update-settings", settings),
  getDictationDefaults: () => ipcRenderer.invoke("marshal:get-dictation-defaults") as Promise<{ prompt: string }>
};

contextBridge.exposeInMainWorld("marshalDesktop", desktopApi);

declare global {
  interface Window {
    marshalDesktop: typeof desktopApi;
    marshalTranslator: typeof translatorApi;
  }
}
