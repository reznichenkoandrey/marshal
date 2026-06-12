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
  getSetupHealth: () => ipcRenderer.invoke("marshal:get-setup-health") as Promise<{
    items: Array<{
      id: string;
      label: string;
      status: "ok" | "warn" | "error" | "unknown";
      detail: string;
      action?: string;
    }>;
    counts: { ok: number; warn: number; error: number; unknown: number };
  }>,
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
    dictationHoldDelayMs?: number;
    dictationToggleTapCount?: number;
    dictationPrompt?: string;
    dictationMicrophone?: string;
  }) => ipcRenderer.invoke("marshal:update-settings", settings),
  getDictationDefaults: () => ipcRenderer.invoke("marshal:get-dictation-defaults") as Promise<{ prompt: string }>,
  listMicrophones: () => ipcRenderer.invoke("marshal:dictation-list-mics") as Promise<{
    ok: boolean;
    devices: Array<{ id: string; name: string; isDefault: boolean; manufacturer: string; transportType: string }>;
    error?: string;
  }>,
  checkForUpdatesSilent: () => ipcRenderer.invoke("marshal:check-for-updates-silent") as Promise<
    | { available: false; error: string }
    | {
        available: false;
        currentVersion: string;
        latestVersion: string;
        releaseUrl: string;
        downloadUrl: string | null;
        releaseNotes: string;
        installable: { zipUrl: string; sha512: string; size: number; version: string } | null;
      }
    | {
        available: true;
        currentVersion: string;
        latestVersion: string;
        releaseUrl: string;
        downloadUrl: string | null;
        releaseNotes: string;
        installable: { zipUrl: string; sha512: string; size: number; version: string } | null;
      }
    | { error: string }
  >,
  startUpdateInstall: () =>
    ipcRenderer.invoke("marshal:start-update-install") as Promise<{ ok: true; version: string }>,
  onUpdateInstallProgress: (
    cb: (
      event: IpcRendererEvent,
      payload: {
        phase:
          | "starting"
          | "downloading"
          | "verifying"
          | "extracting"
          | "staging"
          | "relaunching"
          | "done"
          | "error";
        ratio: number;
        message?: string;
        bytesDownloaded?: number;
        bytesTotal?: number;
      }
    ) => void
  ) =>
    registerListener<[
      {
        phase:
          | "starting"
          | "downloading"
          | "verifying"
          | "extracting"
          | "staging"
          | "relaunching"
          | "done"
          | "error";
        ratio: number;
        message?: string;
        bytesDownloaded?: number;
        bytesTotal?: number;
      }
    ]>("marshal:update-install-progress", cb),
  openExternal: (url: string) => ipcRenderer.invoke("marshal:open-external", url) as Promise<{ ok: true }>
};

contextBridge.exposeInMainWorld("marshalDesktop", desktopApi);

// ── Capture API ──
// Exposed to the capture editor and recording-indicator renderers. Namespaced
// so the translator and capture windows don't accidentally share state.
const captureApi = {
  // Main → renderer: image payload for the editor.
  onImageLoaded: (
    cb: (
      event: IpcRendererEvent,
      payload: { base64: string; width: number; height: number; kind: "area" | "fullscreen" }
    ) => void
  ) =>
    registerListener<[
      { base64: string; width: number; height: number; kind: "area" | "fullscreen" }
    ]>("marshal:capture-image-loaded", cb),
  // Renderer → main: persist / copy / close operations.
  saveAs: (base64Png: string) => ipcRenderer.invoke("marshal:capture-save-as", { base64: base64Png }),
  saveQuick: (base64Png: string) => ipcRenderer.invoke("marshal:capture-save-quick", { base64: base64Png }),
  copy: (base64Png: string) => ipcRenderer.invoke("marshal:capture-copy", { base64: base64Png }),
  pin: (base64Png: string) => ipcRenderer.invoke("marshal:capture-pin", { base64: base64Png }),
  close: () => ipcRenderer.invoke("marshal:capture-close"),
  // Recording indicator ↔ main.
  recordingToggle: (paused: boolean) => ipcRenderer.invoke("marshal:recording-toggle", { paused }),
  recordingStop: () => ipcRenderer.invoke("marshal:recording-stop"),
  onRecordingPaused: (cb: (event: IpcRendererEvent, payload: { paused: boolean }) => void) =>
    registerListener<[{ paused: boolean }]>("marshal:recording-paused", cb),
  // GIF dialog ↔ main.
  gifStart: (opts: { inputPath: string; fps: number; width: number; loop: boolean }) =>
    ipcRenderer.invoke("marshal:gif-start", opts),
  gifClose: () => ipcRenderer.invoke("marshal:gif-close"),
  onGifInit: (cb: (event: IpcRendererEvent, payload: { inputPath: string }) => void) =>
    registerListener<[{ inputPath: string }]>("marshal:gif-init", cb),
  onGifProgress: (cb: (event: IpcRendererEvent, payload: { progress: number }) => void) =>
    registerListener<[{ progress: number }]>("marshal:gif-progress", cb),
  onGifDone: (cb: (event: IpcRendererEvent, payload: { outputPath: string }) => void) =>
    registerListener<[{ outputPath: string }]>("marshal:gif-done", cb),
  onGifError: (cb: (event: IpcRendererEvent, payload: { message: string }) => void) =>
    registerListener<[{ message: string }]>("marshal:gif-error", cb)
};

contextBridge.exposeInMainWorld("marshalCapture", captureApi);

// ── Dictation API ──
// Used exclusively by the floating dictation indicator
// (renderer/dictation-indicator.html). The indicator is a tiny renderer with
// only one user-actionable control — Stop — so the surface stays minimal.
const dictationApi = {
  stop: () => ipcRenderer.invoke("marshal:dictation-stop")
};

contextBridge.exposeInMainWorld("marshalDictation", dictationApi);

// ── Meeting API ──
const meetingApi = {
  stop: () => ipcRenderer.invoke("marshal:meeting-stop")
};

contextBridge.exposeInMainWorld("marshalMeeting", meetingApi);

// ── Capture History API ──
// Used exclusively by the history viewer window (capture-history.html).
const historyApi = {
  onLoaded: (
    cb: (
      event: IpcRendererEvent,
      payload: {
        folder: string;
        entries: Array<{
          path: string;
          name: string;
          kind: "image" | "video" | "gif" | "other";
          bytes: number;
          modifiedAt: number;
        }>;
      }
    ) => void
  ) =>
    registerListener<[
      {
        folder: string;
        entries: Array<{
          path: string;
          name: string;
          kind: "image" | "video" | "gif" | "other";
          bytes: number;
          modifiedAt: number;
        }>;
      }
    ]>("marshal:capture-history-loaded", cb),
  refresh: () => ipcRenderer.invoke("marshal:capture-history:refresh"),
  openInEditor: (filePath: string) =>
    ipcRenderer.invoke("marshal:capture-history:open-in-editor", { path: filePath }),
  openExternal: (filePath: string) =>
    ipcRenderer.invoke("marshal:capture-history:open-external", { path: filePath }),
  reveal: (filePath: string) =>
    ipcRenderer.invoke("marshal:capture-history:reveal", { path: filePath }),
  revealFolder: () => ipcRenderer.invoke("marshal:capture-history:reveal-folder"),
  close: () => ipcRenderer.invoke("marshal:capture-history:close")
};

contextBridge.exposeInMainWorld("marshalHistory", historyApi);

// ── Floating toolbar API ──
const toolbarApi = {
  captureArea: () => ipcRenderer.invoke("marshal:toolbar:capture-area"),
  captureFullscreen: () => ipcRenderer.invoke("marshal:toolbar:capture-fullscreen"),
  toggleRecording: () => ipcRenderer.invoke("marshal:toolbar:toggle-recording"),
  openGifConverter: () => ipcRenderer.invoke("marshal:toolbar:open-gif"),
  openHistory: () => ipcRenderer.invoke("marshal:toolbar:open-history"),
  pollRecordingState: () =>
    ipcRenderer.invoke("marshal:toolbar:recording-state") as Promise<{ recording: boolean }>,
  onRecordingState: (cb: (event: IpcRendererEvent, payload: { recording: boolean }) => void) =>
    registerListener<[{ recording: boolean }]>("marshal:toolbar:recording-state-changed", cb),
  close: () => ipcRenderer.invoke("marshal:toolbar:close")
};

contextBridge.exposeInMainWorld("marshalToolbar", toolbarApi);

declare global {
  interface Window {
    marshalDesktop: typeof desktopApi;
    marshalTranslator: typeof translatorApi;
    marshalCapture: typeof captureApi;
    marshalMeeting: typeof meetingApi;
    marshalHistory: typeof historyApi;
    marshalToolbar: typeof toolbarApi;
  }
}
