import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { app, BrowserWindow, clipboard, dialog, Menu, Notification, Tray, ipcMain, nativeImage, shell, globalShortcut, systemPreferences } from "electron";

import { DesktopBackendClient } from "./backend-client.ts";
import { CaptureService, type CaptureResult } from "./capture/capture-service.ts";
import { CaptureWindow } from "./capture/capture-window.ts";
import { runCountdown } from "./capture/countdown-window.ts";
import { pickArea } from "./capture/area-picker.ts";
import { RecordingIndicator } from "./capture/recording-indicator.ts";
import { VideoRecorder } from "./capture/video-recorder.ts";
import { DictationService } from "./dictation/dictation-service.ts";
import { DEFAULT_DICTATION_PROMPT } from "./dictation/whisper-backend.ts";
import { applySettingsToEnv, loadSettings, saveSettings, type MarshalSettings } from "./settings-store.ts";
import { ClipboardMonitor } from "./translator/clipboard-monitor.ts";
import { TranslatorHistoryStore, type HistoryItem } from "./translator/history-store.ts";
import { LayoutSwitcher } from "./translator/layout-switcher.ts";
import { TranslatorService } from "./translator/translator-service.ts";
import { TranslatorWindow } from "./translator/translator-window.ts";
import { ScreenshotService } from "./translator/screenshot-service.ts";
import { getSharedLocalBridgeServer } from "../agent/bridge/local-bridge-server.ts";

// Load .env from project root before anything else. `override: false` matches
// the previous custom parser's behaviour — existing environment variables win
// over values declared in the .env file.
const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const projectRootDir = path.resolve(desktopDistDir, "..", "..");
const envPath = path.join(projectRootDir, ".env");
loadDotenv({ path: envPath, override: false });
const preloadPath = path.join(desktopDistDir, "preload.cjs");
const rendererHtmlPath = path.join(desktopDistDir, "renderer", "index.html");
const appIconPath = path.join(projectRootDir, "assets", "icon.png");

const backendClient = new DesktopBackendClient();

let translatorService: TranslatorService | null = null;
let translatorWindow: TranslatorWindow | null = null;
let screenshotService: ScreenshotService | null = null;
let captureService: CaptureService | null = null;
let captureWindow: CaptureWindow | null = null;
let videoRecorder: VideoRecorder | null = null;
let recordingIndicator: RecordingIndicator | null = null;
let isRecording = false;
let clipboardMonitor: ClipboardMonitor | null = null;
let layoutSwitcher: LayoutSwitcher | null = null;
let translatorHistory: TranslatorHistoryStore | null = null;
let dictationService: DictationService | null = null;
let isDictating = false;

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
    // Single-instance lock — a leftover process from a previous run (or a
    // zombie tray) otherwise gives the user two tray icons (#51).
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    app.on("second-instance", () => {
      if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
      }
    });

    await app.whenReady();
    if (process.platform === "darwin") {
      app.setActivationPolicy("accessory");
    }

    // Settings override .env values. Must be applied BEFORE the backend utility
    // process forks so the child inherits the correct env.
    applySettingsToEnv(loadSettings());

    registerIpcHandlers();
    createMainWindow();
    createTray();
    scheduleTrayRefresh();
    initTranslator();
    initCapture();
    initDictation();
    void initExtensionBridge();

    app.on("activate", () => {
      if (!mainWindow) {
        createMainWindow();
      }
      showMainWindow();
    });

    // Mark quitting early so other listeners (e.g. blur → hide) stop firing.
    app.on("before-quit", () => {
      isQuitting = true;
    });

    // Async teardown must finish before the process exits. `will-quit` fires
    // after every window is closed and supports `event.preventDefault()` so we
    // can await backend/child-process exit without losing state.
    let teardownPromise: Promise<void> | null = null;
    app.on("will-quit", (event) => {
      if (teardownPromise) return;
      event.preventDefault();
      teardownPromise = performTeardown()
        .catch((err) => {
          console.error("[marshal] teardown failed:", err);
        })
        .finally(() => {
          // Re-invoke quit — the guard (`teardownPromise` non-null) lets the
          // second pass proceed without preventing default again.
          app.exit(0);
        });
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

  handleIpc("marshal:get-settings", () => loadSettings());
  handleIpc("marshal:get-dictation-defaults", () => ({ prompt: DEFAULT_DICTATION_PROMPT }));
  handleIpc("marshal:update-settings", async (_event, next: Partial<MarshalSettings>) => {
    const saved = saveSettings(next ?? {});
    applySettingsToEnv(saved);
    // Hot-swap the translator so the new choice takes effect without waiting
    // for a full app restart. Apply bridge FIRST so "auto" resolves against
    // the up-to-date provider before setBackend re-reads the choice.
    translatorService?.setBridgeMode(saved.bridgeMode);
    translatorService?.setBackend(saved.translatorBackend);
    // Restart the agent backend so the new provider/model values reach the
    // reasoning bridge.
    await backendClient.restart();
    return saved;
  });

  // Translator IPC handlers
  handleIpc("marshal:translator-translate-text", async (_event, { text, targetLang }: { text: string; targetLang: "uk" | "en" }) => {
    const { service, window } = ensureTranslator();
    window.showLoading("text");
    try {
      const result = await service.translateText(text, targetLang);
      window.showWithText(text, result.translation, result.sourceLang, result.targetLang);
      pushHistory({
        text,
        translation: result.translation,
        sourceLang: result.sourceLang,
        targetLang: result.targetLang,
        mode: "text",
        timestamp: Date.now()
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      window.showError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  });

  handleIpc("marshal:translator-translate-image", async (_event, { base64, mimeType, targetLang }: { base64: string; mimeType: string; targetLang: "uk" | "en" }) => {
    const { service, window } = ensureTranslator();
    window.showLoading("image");
    try {
      const result = await service.translateImage(base64, mimeType, targetLang);
      window.showImageResult(result.translation, result.targetLang);
      pushHistory({
        text: "",
        translation: result.translation,
        sourceLang: result.sourceLang,
        targetLang: result.targetLang,
        mode: "image",
        timestamp: Date.now()
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      window.showError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  });

  handleIpc("marshal:translator-history-list", () => translatorHistory?.list() ?? []);
  handleIpc("marshal:translator-history-clear", () => {
    translatorHistory?.clear();
    return [];
  });

  handleIpc("marshal:translator-capture-screen", async () => {
    if (!screenshotService) {
      throw new Error("Screenshot service is not initialized.");
    }
    return screenshotService.captureWithCrop();
  });

  handleIpc("marshal:translator-close", () => {
    if (!translatorWindow) {
      throw new Error("Translator window is not initialized.");
    }
    translatorWindow.hide();
  });

  handleIpc("marshal:translator-open", () => {
    if (!translatorWindow) {
      throw new Error("Translator window is not initialized.");
    }
    translatorWindow.show();
  });

  // ── Capture IPC ─────────────────────────────────────────────────────────
  handleIpc("marshal:capture-area", async () => {
    await runCapture("area");
  });
  handleIpc("marshal:capture-fullscreen", async () => {
    await runCapture("fullscreen");
  });

  handleIpc("marshal:capture-save-as", async (_event, input: { base64: string }) => {
    const defaultName = defaultCaptureFilename();
    const result = await dialog.showSaveDialog({
      title: "Save capture",
      defaultPath: path.join(app.getPath("desktop"), defaultName),
      filters: [{ name: "PNG Image", extensions: ["png"] }]
    });
    if (result.canceled || !result.filePath) return { path: null };
    fs.writeFileSync(result.filePath, Buffer.from(input.base64, "base64"));
    return { path: result.filePath };
  });

  handleIpc("marshal:capture-save-quick", async (_event, input: { base64: string }) => {
    const settings = loadSettings();
    const folder = settings.captureDefaultFolder || app.getPath("desktop");
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    const filePath = path.join(folder, defaultCaptureFilename());
    fs.writeFileSync(filePath, Buffer.from(input.base64, "base64"));
    return { path: filePath };
  });

  handleIpc("marshal:capture-copy", (_event, input: { base64: string }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(input.base64, "base64"));
    clipboard.writeImage(image);
    return { ok: true };
  });

  handleIpc("marshal:capture-pin", (_event, input: { base64: string }) => {
    openPinnedWindow(input.base64);
    return { ok: true };
  });

  handleIpc("marshal:capture-close", () => {
    captureWindow?.close();
    return { ok: true };
  });

  handleIpc("marshal:recording-toggle", (_event, input: { paused: boolean }) => {
    if (!videoRecorder || !isRecording) return { ok: false };
    if (input.paused) {
      videoRecorder.pause();
    } else {
      videoRecorder.resume();
    }
    return { ok: true };
  });

  handleIpc("marshal:recording-stop", async () => {
    await stopVideoRecording();
    return { ok: true };
  });
}

async function runCapture(kind: "area" | "fullscreen"): Promise<void> {
  if (!captureService || !captureWindow) return;

  // Hide Marshal's own windows so they don't leak into the frame.
  translatorWindow?.hide();
  const mainWasVisible = mainWindow?.isVisible() ?? false;
  if (mainWasVisible) mainWindow?.hide();
  await new Promise<void>((r) => setTimeout(r, 120));

  try {
    let result: CaptureResult | null;
    if (kind === "area") {
      result = await captureService.captureArea();
    } else {
      result = await captureService.captureFullscreen();
    }
    if (!result) return;
    captureWindow.openEditor({ capture: result });
  } catch (err) {
    if (Notification.isSupported()) {
      new Notification({
        title: "Marshal — Capture failed",
        body: err instanceof Error ? err.message : String(err),
        silent: true
      }).show();
    }
    console.error("[marshal] capture failed:", err);
  } finally {
    if (mainWasVisible) mainWindow?.show();
  }
}

function defaultCaptureFilename(): string {
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `Marshal ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.png`;
}

function openPinnedWindow(base64Png: string): void {
  const image = nativeImage.createFromBuffer(Buffer.from(base64Png, "base64"));
  const { width, height } = image.getSize();
  const win = new BrowserWindow({
    width: Math.min(width, 900),
    height: Math.min(height, 700),
    frame: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const dataUrl = `data:image/png;base64,${base64Png}`;
  const html = `<!doctype html><html><head><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;background:transparent;overflow:hidden;-webkit-app-region:drag}
    img{width:100%;height:100%;object-fit:contain;display:block;-webkit-user-drag:none;pointer-events:none}
    body:hover .close{opacity:1}
    .close{position:fixed;top:6px;right:6px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;border:0;cursor:pointer;opacity:0;transition:opacity .15s;-webkit-app-region:no-drag;font:700 14px/1 system-ui}
  </style></head><body><img src="${dataUrl}"/><button class="close" onclick="window.close()">×</button></body></html>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function handleIpc(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, listener);
}

function ensureTranslator(): { service: TranslatorService; window: TranslatorWindow } {
  if (!translatorService || !translatorWindow) {
    throw new Error("Translator is not initialized.");
  }
  return { service: translatorService, window: translatorWindow };
}

function pushHistory(item: HistoryItem): void {
  try {
    translatorHistory?.push(item);
  } catch (err) {
    console.warn("[marshal] failed to persist translator history:", err);
  }
}

async function performTeardown(): Promise<void> {
  if (trayRefreshTimer) {
    clearInterval(trayRefreshTimer);
    trayRefreshTimer = null;
  }
  clipboardMonitor?.stop();
  layoutSwitcher?.stop();
  dictationService?.stop();
  captureWindow?.close();
  recordingIndicator?.hide();
  videoRecorder?.kill();
  // Release every registered accelerator, including any new ones added later.
  // Safer than tracking each shortcut by name.
  globalShortcut.unregisterAll();
  await backendClient.disposeAsync();
  await getSharedLocalBridgeServer().close().catch(() => undefined);
}

async function initExtensionBridge(): Promise<void> {
  // HTTP server on 127.0.0.1:3210 that the Chrome side-panel talks to for
  // `/chat` (Claude CLI subscription) and picker routing. Must be up before
  // the user opens the side panel — the extension fails loudly otherwise.
  try {
    await getSharedLocalBridgeServer().start();
    console.log(`[marshal] extension bridge listening on http://127.0.0.1:${getSharedLocalBridgeServer().port}`);
  } catch (error) {
    console.error("[marshal] extension bridge failed to start:", error);
  }
}

function initDictation(): void {
  const enabled = (process.env.MARSHAL_DICTATION_ENABLED ?? "1") !== "0";
  if (!enabled) return;

  try {
    dictationService = new DictationService();
  } catch (err) {
    console.warn("[marshal] dictation disabled:", err instanceof Error ? err.message : err);
    return;
  }

  dictationService.on("recording-start", () => {
    isDictating = true;
    void refreshTrayState();
  });
  dictationService.on("recording-stop", () => {
    isDictating = false;
    void refreshTrayState();
  });
  dictationService.on("transcribed", ({ text }) => {
    if (!Notification.isSupported()) return;
    const preview = text.length > 80 ? `${text.slice(0, 77)}…` : text;
    new Notification({ title: "Marshal — Dictated", body: preview, silent: true }).show();
  });
  dictationService.on("error", (err: Error) => {
    console.error("[dictation] error:", err);
    if (!Notification.isSupported()) return;
    new Notification({ title: "Marshal — Dictation error", body: err.message, silent: true }).show();
  });

  void dictationService.start();
}

function initCapture(): void {
  captureService = new CaptureService(preloadPath);
  captureWindow = new CaptureWindow(preloadPath);
  recordingIndicator = new RecordingIndicator(preloadPath);

  if (VideoRecorder.isAvailable()) {
    videoRecorder = new VideoRecorder();
    videoRecorder.on("error", (err: Error) => {
      console.error("[marshal] video recorder error:", err);
      if (Notification.isSupported()) {
        new Notification({
          title: "Marshal — Recording error",
          body: err.message,
          silent: true
        }).show();
      }
      cleanupRecording();
    });
  } else if (process.platform === "darwin") {
    console.warn("[marshal] screen-recorder binary missing — video capture disabled");
  }

  // Hotkeys. Cmd+Shift+3/4/5/6 collide with macOS native screenshot shortcuts,
  // so we use Cmd+Option+3 / 4 / 5 / 6 to avoid the clash. Users can later
  // rebind via preferences (#72).
  globalShortcut.register("CommandOrControl+Alt+3", () => {
    void runCapture("area");
  });
  globalShortcut.register("CommandOrControl+Alt+4", () => {
    void runCapture("fullscreen");
  });
  globalShortcut.register("CommandOrControl+Alt+6", () => {
    void toggleVideoRecording("fullscreen");
  });
}

async function toggleVideoRecording(kind: "fullscreen" | "area"): Promise<void> {
  if (!videoRecorder) {
    if (Notification.isSupported()) {
      new Notification({
        title: "Marshal — Recording unavailable",
        body: "screen-recorder helper missing. Run `npm run build`.",
        silent: true
      }).show();
    }
    return;
  }

  if (isRecording) {
    await stopVideoRecording();
    return;
  }

  await startVideoRecording(kind);
}

async function startVideoRecording(kind: "fullscreen" | "area"): Promise<void> {
  if (!videoRecorder || isRecording) return;

  // Hide Marshal's own windows so they don't appear in the recording.
  translatorWindow?.hide();
  const mainWasVisible = mainWindow?.isVisible() ?? false;
  if (mainWasVisible) mainWindow?.hide();

  let area: { x: number; y: number; width: number; height: number } | null = null;

  try {
    if (kind === "area") {
      const pick = await pickArea({ preloadPath });
      if (!pick) {
        if (mainWasVisible) mainWindow?.show();
        return;
      }
      area = {
        x: Math.round(pick.region.x),
        y: Math.round(pick.region.y),
        width: Math.round(pick.region.width),
        height: Math.round(pick.region.height)
      };
    }

    await runCountdown(preloadPath, 3);

    const settings = loadSettings();
    const folder = settings.captureDefaultFolder || app.getPath("desktop");
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    const outPath = path.join(folder, defaultVideoFilename());

    isRecording = true;

    await new Promise<void>((resolve, reject) => {
      const onStarted = (): void => {
        videoRecorder?.off("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        videoRecorder?.off("started", onStarted);
        reject(err);
      };
      videoRecorder!.once("started", onStarted);
      videoRecorder!.once("error", onError);
      if (area) {
        videoRecorder!.startArea(area, outPath);
      } else {
        videoRecorder!.startFullscreen(outPath);
      }
    });

    recordingIndicator?.show();
    void refreshTrayState();
  } catch (err) {
    isRecording = false;
    if (Notification.isSupported()) {
      new Notification({
        title: "Marshal — Recording failed",
        body: err instanceof Error ? err.message : String(err),
        silent: true
      }).show();
    }
    if (mainWasVisible) mainWindow?.show();
  }
}

async function stopVideoRecording(): Promise<void> {
  if (!videoRecorder || !isRecording) return;
  try {
    const outPath = await videoRecorder.stop();
    cleanupRecording();
    if (Notification.isSupported()) {
      const name = outPath.split("/").pop() ?? outPath;
      const notif = new Notification({
        title: "Marshal — Recording saved",
        body: name,
        silent: true
      });
      notif.on("click", () => {
        void shell.showItemInFolder(outPath);
      });
      notif.show();
    }
  } catch (err) {
    cleanupRecording();
    if (Notification.isSupported()) {
      new Notification({
        title: "Marshal — Recording failed",
        body: err instanceof Error ? err.message : String(err),
        silent: true
      }).show();
    }
  }
}

function cleanupRecording(): void {
  isRecording = false;
  recordingIndicator?.hide();
  void refreshTrayState();
}

function defaultVideoFilename(): string {
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `Marshal ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.mov`;
}

function initTranslator(): void {
  const settings = loadSettings();
  translatorService = new TranslatorService({
    choice: settings.translatorBackend,
    bridgeMode: settings.bridgeMode
  });
  translatorWindow = new TranslatorWindow(preloadPath);
  screenshotService = new ScreenshotService(preloadPath);
  translatorHistory = new TranslatorHistoryStore(app.getPath("userData"));

  clipboardMonitor = new ClipboardMonitor();
  clipboardMonitor.on("translate", (text: string) => {
    if (!translatorWindow || !translatorService) return;

    translatorWindow.showLoading("text");

    translatorService
      .translateAuto(text)
      .then((result) => {
        translatorWindow!.showWithText(text, result.translation, result.sourceLang, result.targetLang);
        pushHistory({
          text,
          translation: result.translation,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          mode: "text",
          timestamp: Date.now()
        });
      })
      .catch((err: unknown) => {
        translatorWindow!.showError(err instanceof Error ? err.message : String(err));
      });
  });

  clipboardMonitor.start();

  layoutSwitcher = new LayoutSwitcher();
  layoutSwitcher.start();

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
        pushHistory({
          text: "",
          translation: result.translation,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          mode: "image",
          timestamp: Date.now()
        });
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
    if (process.platform !== "darwin" || isQuitting) return;
    // Keep the window open while DevTools is driving the focus, otherwise the
    // devtools panel becomes unusable (parent hides the moment you click into it).
    if (mainWindow?.webContents.isDevToolsOpened()) return;
    mainWindow?.hide();
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
        label: "Capture area",
        accelerator: "CommandOrControl+Alt+3",
        click: () => void runCapture("area")
      },
      {
        label: "Capture full screen",
        accelerator: "CommandOrControl+Alt+4",
        click: () => void runCapture("fullscreen")
      },
      { type: "separator" },
      isRecording
        ? { label: "Stop recording", click: () => void stopVideoRecording() }
        : {
            label: "Record full screen",
            accelerator: "CommandOrControl+Alt+6",
            enabled: videoRecorder !== null,
            click: () => void toggleVideoRecording("fullscreen")
          },
      ...(!isRecording && videoRecorder
        ? [{ label: "Record area", click: () => void toggleVideoRecording("area") }]
        : []),
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

  const base = health
    ? `Marshal\n${health.runningTasks} running, ${health.queuedTasks} queued`
    : "Marshal\nUnavailable";

  const status: string[] = [];
  if (isDictating) status.push("● Recording dictation…");
  if (isRecording) status.push("● Recording screen…");
  tray.setToolTip(status.length > 0 ? `${base}\n${status.join("\n")}` : base);
  // Show a single-character "recording" indicator next to the tray icon so
  // the user can see at a glance that the mic or screen is live.
  tray.setTitle(isDictating || isRecording ? "●" : "");

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
