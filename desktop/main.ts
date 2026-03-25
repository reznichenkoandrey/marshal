import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, Menu, Tray, ipcMain, nativeImage, shell } from "electron";

import { DesktopBackendClient } from "./backend-client.ts";

// Load .env from project root before anything else
const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const projectRootDir = path.resolve(desktopDistDir, "..", "..");
const envPath = path.join(projectRootDir, ".env");
try {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env not found — use existing env vars
}
const preloadPath = path.join(desktopDistDir, "preload.cjs");
const rendererHtmlPath = path.join(desktopDistDir, "renderer", "index.html");
const appIconPath = path.join(projectRootDir, "assets", "icon.png");

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
  workingDir?: string;
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
  handleIpc("marshal:list-projects", () => backendClient.invoke("listProjects"));
  handleIpc("marshal:create-project", (_event, name?: string) => backendClient.invoke("createProject", name));
  handleIpc("marshal:list-sessions", (_event, projectId?: string) =>
    backendClient.invoke("listSessions", projectId)
  );
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
      uploads: Array.isArray(input.attachments) ? input.attachments : [],
      workingDir: typeof input.workingDir === "string" ? input.workingDir : undefined
    })
  );
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
  handleIpc("marshal:select-directory", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  handleIpc("marshal:restart-app", async () => {
    app.relaunch();
    app.exit(0);
  });
}

function handleIpc(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, listener);
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 380,
    minHeight: 520,
    show: false,
    frame: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 8 },
    backgroundColor: "#ffffff",
    icon: appIconPath,
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
  tray.setToolTip("Marshal");

  // Left click = toggle app window
  tray.on("click", () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
      return;
    }
    showMainWindow();
  });

  // Right click = context menu (not left click)
  tray.on("right-click", () => {
    if (!tray) return;
    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Open Marshal",
        click: () => showMainWindow()
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray!.popUpContextMenu(contextMenu);
  });

  void refreshTrayState();
}

async function refreshTrayState(): Promise<void> {
  if (!tray) return;

  const health = await backendClient
    .invoke<{ runningTasks: number; queuedTasks: number }>("getHealth")
    .catch(() => null);

  const label = health
    ? `Marshal\n${health.runningTasks} running, ${health.queuedTasks} queued`
    : "Marshal\nUnavailable";

  tray.setToolTip(label);

  // No title text next to tray icon — just the icon itself

  // Context menu is set via right-click handler in createTray()
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
  if (!mainWindow) return;

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

function createTrayIcon(): Electron.NativeImage {
  // Render tray icon from PNG files generated by scripts/generate-tray-icon.mjs.
  // @2x variant is auto-detected by Electron when the base file is loaded.
  const trayIcon1x = path.join(projectRootDir, "assets", "tray-icon.png");
  const trayIcon2x = path.join(projectRootDir, "assets", "tray-icon@2x.png");

  if (fs.existsSync(trayIcon1x) && fs.existsSync(trayIcon2x)) {
    // Read both sizes and assemble a multi-resolution image.
    // createFromPath auto-detects @2x only when running from asar/packed app,
    // so we build it manually to guarantee retina support in dev mode too.
    const buf1x = fs.readFileSync(trayIcon1x);
    const buf2x = fs.readFileSync(trayIcon2x);
    const img1x = nativeImage.createFromBuffer(buf1x, { scaleFactor: 1.0 });
    const img2x = nativeImage.createFromBuffer(buf2x, { scaleFactor: 2.0 });

    if (!img1x.isEmpty() && !img2x.isEmpty()) {
      // Combine representations into a single image
      const combined = nativeImage.createEmpty();
      combined.addRepresentation({ scaleFactor: 1.0, buffer: img1x.toPNG() });
      combined.addRepresentation({ scaleFactor: 2.0, buffer: img2x.toPNG() });
      return combined;
    }
  }

  // Fallback: generate icon from inline SVG (green rounded rect with white M)
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">',
    '<rect width="36" height="36" rx="8" fill="#0b5c56"/>',
    '<path d="M9 27V9h3.6l5.4 9.2L23.4 9H27v18h-3V14.4l-4.6 7.8h-2.8L12 14.4V27z" fill="white"/>',
    "</svg>",
  ].join("");
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const image = nativeImage.createFromDataURL(dataUrl);
  return image.resize({ width: 18, height: 18 });
}
