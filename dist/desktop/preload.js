import { contextBridge, ipcRenderer } from "electron";
const desktopApi = {
    getHealth: () => ipcRenderer.invoke("marshal:get-health"),
    listProjects: () => ipcRenderer.invoke("marshal:list-projects"),
    createProject: (name) => ipcRenderer.invoke("marshal:create-project", name),
    listSessions: (projectId) => ipcRenderer.invoke("marshal:list-sessions", projectId),
    createSession: (input) => ipcRenderer.invoke("marshal:create-session", input),
    readSession: (input) => ipcRenderer.invoke("marshal:read-session", input),
    deleteSession: (input) => ipcRenderer.invoke("marshal:delete-session", input),
    submitTask: (input) => ipcRenderer.invoke("marshal:submit-task", input),
    openChatGPT: () => ipcRenderer.invoke("marshal:open-chatgpt"),
    openOperatorWeb: () => ipcRenderer.invoke("marshal:open-operator-web"),
    openWorkspace: (input) => ipcRenderer.invoke("marshal:open-workspace", input),
    restartApp: () => ipcRenderer.invoke("marshal:restart-app"),
    restartBackend: () => ipcRenderer.invoke("marshal:restart-backend")
};
contextBridge.exposeInMainWorld("marshalDesktop", desktopApi);
