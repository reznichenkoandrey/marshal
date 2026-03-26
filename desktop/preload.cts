const { contextBridge, ipcRenderer } = require("electron");

// ── Translator API ──
const translatorApi = {
  translateText: (text: string, targetLang: string) =>
    ipcRenderer.invoke("marshal:translator-translate-text", { text, targetLang }),
  translateImage: (base64: string, mimeType: string, targetLang: string) =>
    ipcRenderer.invoke("marshal:translator-translate-image", { base64, mimeType, targetLang }),
  captureScreen: () => ipcRenderer.invoke("marshal:translator-capture-screen"),
  close: () => ipcRenderer.invoke("marshal:translator-close"),
  // Events from main → renderer
  onLoading: (cb: (event: Electron.IpcRendererEvent, data: { mode: string }) => void) =>
    ipcRenderer.on("translator-loading", cb),
  onResult: (cb: (event: Electron.IpcRendererEvent, data: Record<string, unknown>) => void) =>
    ipcRenderer.on("translator-result", cb),
  onError: (cb: (event: Electron.IpcRendererEvent, data: { message: string }) => void) =>
    ipcRenderer.on("translator-error", cb),
  // Crop overlay
  onCropInit: (cb: (event: Electron.IpcRendererEvent, dataUrl: string) => void) =>
    ipcRenderer.on("crop-init", cb),
  selectCrop: (region: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send("marshal:crop-selected", region),
  cancelCrop: () => ipcRenderer.send("marshal:crop-cancelled")
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
  openTranslator: () => ipcRenderer.invoke("marshal:translator-open")
};

contextBridge.exposeInMainWorld("marshalDesktop", desktopApi);

declare global {
  interface Window {
    marshalDesktop: typeof desktopApi;
    marshalTranslator: typeof translatorApi;
  }
}
