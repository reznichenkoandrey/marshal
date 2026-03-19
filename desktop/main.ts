import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } from "electron";

import { DesktopBackendClient } from "./backend-client.ts";

const execFileAsync = promisify(execFile);
const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const distRootDir = path.resolve(desktopDistDir, "..");
const projectRootDir = path.resolve(distRootDir, "..");
const preloadPath = path.join(desktopDistDir, "preload.cjs");
const rendererHtmlPath = path.join(desktopDistDir, "renderer", "index.html");
const chatGptLauncherPath = path.join(projectRootDir, "open-chatgpt-browser-default-profile.sh");
const operatorWebPort = Number(process.env.OPERATOR_WEB_PORT ?? "3489");
const operatorWebUrl = `http://127.0.0.1:${operatorWebPort}`;

const backendClient = new DesktopBackendClient();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayRefreshTimer: NodeJS.Timeout | null = null;
let isQuitting = false;

type DesktopTaskSubmission = {
  sessionId: string;
  projectId?: string;
  text: string;
  route: unknown;
  attachments: unknown[];
};

type DesktopWorkspaceRequest = {
  sessionId: string;
  projectId?: string;
};

void bootstrap();

async function bootstrap(): Promise<void> {
  try {
    await app.whenReady();
    if (process.platform === "darwin") {
      app.setActivationPolicy("accessory");
    }

    registerIpcHandlers();
    createMainWindow();
    createTray();
    scheduleTrayRefresh();

    app.on("activate", () => {
      if (!mainWindow) {
        createMainWindow();
      }
      showMainWindow();
    });

    app.on("before-quit", () => {
      isQuitting = true;
      if (trayRefreshTimer) {
        clearInterval(trayRefreshTimer);
        trayRefreshTimer = null;
      }
      backendClient.dispose();
    });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") {
        app.quit();
      }
    });
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

function registerIpcHandlers(): void {
  handleIpc("marshal:get-health", () => backendClient.invoke("getHealth"));
  handleIpc("marshal:get-bridge-health", () => backendClient.invoke("getBridgeHealth"));
  handleIpc("marshal:list-projects", () => backendClient.invoke("listProjects"));
  handleIpc("marshal:create-project", (_event, name?: string) => backendClient.invoke("createProject", name));
  handleIpc("marshal:list-sessions", (_event, projectId?: string) => backendClient.invoke("listSessions", projectId));
  handleIpc("marshal:create-session", (_event, input?: { title?: string; projectId?: string }) =>
    backendClient.invoke("createSession", input)
  );
  handleIpc("marshal:read-session", (_event, input: { sessionId: string; projectId?: string }) =>
    backendClient.invoke("readSession", input)
  );
  handleIpc("marshal:delete-session", (_event, input: { sessionId: string; projectId?: string }) =>
    backendClient.invoke("deleteSession", input)
  );
  handleIpc("marshal:submit-task", (_event, input: DesktopTaskSubmission) =>
    backendClient.invoke("submitTask", {
      sessionId: input.sessionId,
      projectId: input.projectId,
      text: String(input.text ?? ""),
      route: input.route,
      uploads: Array.isArray(input.attachments) ? input.attachments : []
    })
  );
  handleIpc("marshal:open-chatgpt", async () => {
    const result = await execFileAsync(chatGptLauncherPath, {
      cwd: projectRootDir,
      env: process.env
    });
    return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  });
  handleIpc("marshal:open-operator-web", async () => {
    await shell.openExternal(operatorWebUrl);
    return operatorWebUrl;
  });
  handleIpc("marshal:open-workspace", async (_event, input: DesktopWorkspaceRequest) => {
    const sessionPaths = await backendClient.invoke<{
      workspaceDir: string;
    }>("getSessionPaths", input);
    const failure = await shell.openPath(sessionPaths.workspaceDir);
    if (failure) {
      throw new Error(failure);
    }
    return sessionPaths.workspaceDir;
  });
  handleIpc("marshal:restart-app", async () => {
    app.relaunch();
    app.exit(0);
  });
  handleIpc("marshal:restart-backend", async () => {
    await backendClient.restart();
    return backendClient.invoke("getHealth");
  });
}

function handleIpc(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, listener);
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 420,
    minHeight: 640,
    show: false,
    frame: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#efe8db",
    vibrancy: "under-window",
    visualEffectState: "active",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("blur", () => {
    if (process.platform === "darwin" && !isQuitting) {
      mainWindow?.hide();
    }
  });

  void mainWindow.loadFile(rendererHtmlPath);
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("Marshal Desktop");
  tray.on("click", () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
      return;
    }
    showMainWindow();
  });

  void refreshTrayState();
}

async function refreshTrayState(): Promise<void> {
  if (!tray) {
    return;
  }

  const health = await backendClient.invoke<{
    runningTasks: number;
    queuedTasks: number;
  }>("getHealth").catch(() => null);
  const bridgeHealth = await backendClient
    .invoke<{
      status: string;
      mode: string;
      client?: { state?: string } | null;
    }>("getBridgeHealth")
    .catch(() => null);
  const label = health
    ? `Marshal Desktop\n${health.runningTasks} running, ${health.queuedTasks} queued\nBridge: ${bridgeHealth?.status ?? "unknown"}`
    : "Marshal Desktop\nUnavailable";

  tray.setToolTip(label);
  if (process.platform === "darwin") {
    const bridgeBadge =
      bridgeHealth?.status === "ready" ? "R" : bridgeHealth?.status === "connected" ? "C" : "W";
    tray.setTitle(health ? `${health.runningTasks}/${health.queuedTasks}/${bridgeBadge}` : "!");
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Marshal",
        click: () => showMainWindow()
      },
      {
        label: "Open ChatGPT",
        click: () => {
          void execFileAsync(chatGptLauncherPath, {
            cwd: projectRootDir,
            env: process.env
          }).catch((error) => {
            console.error(error);
          });
        }
      },
      {
        label: "Open Web Console",
        click: () => {
          void shell.openExternal(operatorWebUrl);
        }
      },
      {
        label: "Restart Backend",
        click: () => {
          void backendClient.restart().catch((error) => {
            console.error(error);
          });
        }
      },
      {
        label: "Restart App",
        click: () => {
          app.relaunch();
          app.exit(0);
        }
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function scheduleTrayRefresh(): void {
  if (trayRefreshTimer) {
    clearInterval(trayRefreshTimer);
  }

  trayRefreshTimer = setInterval(() => {
    void refreshTrayState();
  }, 5000);
}

function showMainWindow(): void {
  if (!mainWindow) {
    return;
  }

  if (tray && process.platform === "darwin") {
    const trayBounds = tray.getBounds();
    const windowBounds = mainWindow.getBounds();
    const x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);
    const y = Math.round(trayBounds.y + trayBounds.height + 8);
    mainWindow.setPosition(x, y, false);
  }

  mainWindow.show();
  mainWindow.focus();
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
      <rect x="1" y="1" width="16" height="16" rx="5" fill="black" />
      <path d="M5 6.2h2.2l1.8 3 1.8-3H13l-2.8 4.5L13 15h-2.2l-1.8-3-1.8 3H5l2.8-4.3L5 6.2Z" fill="white" />
    </svg>
  `.trim();
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  image.setTemplateImage(true);
  return image.resize({ width: 18, height: 18 });
}
