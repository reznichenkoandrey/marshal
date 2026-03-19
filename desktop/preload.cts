const { contextBridge, ipcRenderer } = require("electron");

const desktopApi = {
  getHealth: () => ipcRenderer.invoke("marshal:get-health"),
  getBridgeHealth: () => ipcRenderer.invoke("marshal:get-bridge-health"),
  listProjects: () => ipcRenderer.invoke("marshal:list-projects"),
  createProject: (name: string) => ipcRenderer.invoke("marshal:create-project", name),
  listSessions: (projectId?: string) => ipcRenderer.invoke("marshal:list-sessions", projectId),
  createSession: (input?: { title?: string; projectId?: string }) => ipcRenderer.invoke("marshal:create-session", input),
  readSession: (input: { sessionId: string; projectId?: string }) => ipcRenderer.invoke("marshal:read-session", input),
  deleteSession: (input: { sessionId: string; projectId?: string }) =>
    ipcRenderer.invoke("marshal:delete-session", input),
  submitTask: (input: {
    sessionId: string;
    projectId?: string;
    text: string;
    route: string;
    attachments: unknown[];
  }) => ipcRenderer.invoke("marshal:submit-task", input),
  openChatGPT: () => ipcRenderer.invoke("marshal:open-chatgpt"),
  openOperatorWeb: () => ipcRenderer.invoke("marshal:open-operator-web"),
  openWorkspace: (input: { sessionId: string; projectId?: string }) => ipcRenderer.invoke("marshal:open-workspace", input),
  restartApp: () => ipcRenderer.invoke("marshal:restart-app"),
  restartBackend: () => ipcRenderer.invoke("marshal:restart-backend")
};

contextBridge.exposeInMainWorld("marshalDesktop", desktopApi);

declare global {
  interface Window {
    marshalDesktop: typeof desktopApi;
  }
}
