import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, Menu, Tray, ipcMain, nativeImage, shell, globalShortcut, systemPreferences } from "electron";

import { DesktopBackendClient } from "./backend-client.ts";
import { ClipboardMonitor } from "./translator/clipboard-monitor.ts";
import { TranslatorService } from "./translator/translator-service.ts";
import { TranslatorWindow } from "./translator/translator-window.ts";
import { ScreenshotService } from "./translator/screenshot-service.ts";

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

let translatorService: TranslatorService | null = null;
let translatorWindow: TranslatorWindow | null = null;
let screenshotService: ScreenshotService | null = null;
let clipboardMonitor: ClipboardMonitor | null = null;

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
    initTranslator();

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
      clipboardMonitor?.stop();
      globalShortcut.unregister("CommandOrControl+Shift+2");
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

  // Translator IPC handlers
  handleIpc("marshal:translator-translate-text", async (_event, { text, targetLang }: { text: string; targetLang: "uk" | "en" }) => {
    if (!translatorService || !translatorWindow) return;
    translatorWindow.showLoading("text");
    try {
      const result = await translatorService.translateText(text, targetLang);
      translatorWindow.showWithText(text, result.translation, result.sourceLang, result.targetLang);
      return result;
    } catch (err) {
      translatorWindow.showError(err instanceof Error ? err.message : String(err));
    }
  });

  handleIpc("marshal:translator-translate-image", async (_event, { base64, mimeType, targetLang }: { base64: string; mimeType: string; targetLang: "uk" | "en" }) => {
    if (!translatorService || !translatorWindow) return;
    translatorWindow.showLoading("image");
    try {
      const result = await translatorService.translateImage(base64, mimeType, targetLang);
      translatorWindow.showImageResult(result.translation, result.targetLang);
      return result;
    } catch (err) {
      translatorWindow.showError(err instanceof Error ? err.message : String(err));
    }
  });

  handleIpc("marshal:translator-capture-screen", async () => {
    if (!screenshotService) return null;
    return screenshotService.captureWithCrop();
  });

  handleIpc("marshal:translator-close", () => {
    translatorWindow?.hide();
  });

  handleIpc("marshal:translator-open", () => {
    translatorWindow?.show();
  });
}

function handleIpc(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, listener);
}

function initTranslator(): void {
  translatorService = new TranslatorService();
  translatorWindow = new TranslatorWindow(preloadPath);
  screenshotService = new ScreenshotService(preloadPath);

  clipboardMonitor = new ClipboardMonitor();
  clipboardMonitor.on("translate", (text: string) => {
    if (!translatorWindow || !translatorService) return;

    translatorWindow.showLoading("text");

    translatorService
      .translateAuto(text)
      .then((result) => {
        translatorWindow!.showWithText(text, result.translation, result.sourceLang, result.targetLang);
      })
      .catch((err: unknown) => {
        translatorWindow!.showError(err instanceof Error ? err.message : String(err));
      });
  });

  clipboardMonitor.start();

  // Check required macOS permissions at startup and prompt user to grant them.
  // Accessibility: needed for double Cmd+C detection via uiohook-napi.
  //   ClipboardMonitor.startKeyHook() calls isTrustedAccessibilityClient(true)
  //   which shows the macOS system prompt — no extra dialog needed here.
  //
  // Screen Recording: needed for desktopCapturer (OCR screenshot translation).
  //   macOS 12+ no longer auto-prompts — user must grant manually.
  if (process.platform === "darwin") {
    const screenStatus = systemPreferences.getMediaAccessStatus("screen");
    if (screenStatus !== "granted") {
      setTimeout(() => {
        void dialog.showMessageBox({
          type: "info",
          title: "Screen Recording Permission Required",
          message: "Marshal needs Screen Recording access for OCR translation.",
          detail:
            "Go to System Settings → Privacy & Security → Screen Recording\n" +
            "and enable Marshal.\n\n" +
            "After granting, restart Marshal for the change to take effect.",
          buttons: ["Open System Settings", "Later"],
          defaultId: 0,
          cancelId: 1
        }).then(({ response }) => {
          if (response === 0) {
            void shell.openExternal(
              "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            );
          }
        });
      }, 2000);
    }
  }

  // Global hotkey: Cmd+Shift+2 — screen capture → OCR translate
  // Hide translator window first so it doesn't appear in the capture
  globalShortcut.register("CommandOrControl+Shift+2", () => {
    void (async () => {
      if (!screenshotService || !translatorService || !translatorWindow) return;

      translatorWindow.hide();
      // Brief pause to let the window actually disappear before capturing
      await new Promise<void>((r) => setTimeout(r, 120));

      try {
        const base64 = await screenshotService.captureWithCrop();
        if (!base64) return; // user cancelled

        translatorWindow.showLoading("image");
        const result = await translatorService.translateImage(base64, "image/png", "uk");
        translatorWindow.showImageResult(result.translation, result.targetLang);
      } catch (err) {
        // Ensure the translator window is visible so the user sees the error
        translatorWindow.show();
        translatorWindow.showError(err instanceof Error ? err.message : String(err));
      }
    })();
  });
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
      {
        label: "Open Translator",
        click: () => translatorWindow?.show()
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
  // macOS template image: black glyph on transparent background.
  // Electron + macOS auto-adapt for dark/light mode.
  // Use "Template" suffix in filename — Electron recognizes this convention.
  const trayIcon2xPath = path.join(projectRootDir, "assets", "tray-icon-template@2x.png");
  const trayIconPath = path.join(projectRootDir, "assets", "tray-icon-template.png");

  let img: Electron.NativeImage;

  if (fs.existsSync(trayIcon2xPath)) {
    img = nativeImage.createFromPath(trayIcon2xPath);
    img = img.resize({ width: 18, height: 18 });
  } else if (fs.existsSync(trayIconPath)) {
    img = nativeImage.createFromPath(trayIconPath);
  } else {
    // Inline fallback
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 32 32">
      <path d="M8 24V8h3.2l4.8 8.2L20.8 8H24v16h-2.7V13l-4.1 6.9h-2.4L10.7 13V24z" fill="black"/>
    </svg>`;
    img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  }

  img.setTemplateImage(true);
  return img;
}
