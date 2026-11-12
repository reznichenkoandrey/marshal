import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { config as loadDotenv } from "dotenv";
import { app, BrowserWindow, clipboard, dialog, Menu, Notification, Tray, ipcMain, nativeImage, shell, globalShortcut, systemPreferences, screen } from "electron";

import { DesktopBackendClient } from "./backend-client.ts";
import { CaptureService, type CaptureResult } from "./capture/capture-service.ts";
import { CaptureWindow } from "./capture/capture-window.ts";
import { CaptureHistoryWindow } from "./capture/capture-history-window.ts";
import { CaptureArchive } from "./capture/capture-archive.ts";
import { FloatingToolbar } from "./capture/floating-toolbar.ts";
import { ScrollCapture } from "./capture/scroll-capture.ts";
import { UpdateChecker, type UpdateCheckOutcome } from "./updater/update-checker.ts";
import { UpdateInstaller, type InstallProgress } from "./updater/update-installer.ts";
import { planSwap } from "./updater/swap-planner.ts";
import { runCountdown } from "./capture/countdown-window.ts";
import { pickArea } from "./capture/area-picker.ts";
import { RecordingIndicator } from "./capture/recording-indicator.ts";
import { VideoRecorder } from "./capture/video-recorder.ts";
import { GifDialog } from "./capture/gif-dialog.ts";
import { GifEncoder } from "./capture/gif-encoder.ts";
import { DEFAULT_CAPTIONS_HOTKEY, DEFAULT_CAPTIONS_OCR_HOTKEY, DEFAULT_CAPTIONS_PROMPT } from "./captions/captions-defaults.ts";
import { LiveCaptionsService } from "./captions/captions-service.ts";
import { SpeechService } from "./speech/speech-service.ts";
import { installPiper } from "./speech/piper.ts";
import { installHolos } from "./speech/holos.ts";
import { warmUpAppleVisionOcr } from "./translator/backends/apple-vision-backend.ts";
import { DictationService } from "./dictation/dictation-service.ts";
import { DictationIndicator } from "./dictation/dictation-indicator.ts";
import { openMicAllowed, type OpenMicState } from "./dictation/end-of-speech.ts";
import { detectMacOSDictationEnabled } from "./dictation/macos-dictation-detect.ts";
import { listMicrophones } from "./dictation/mic-discover.ts";
import { DEFAULT_DICTATION_PROMPT, resolveWhisperAssetPaths } from "./dictation/whisper-backend.ts";
import { stopSharedWhisperServer } from "./dictation/whisper-server.ts";
import { defaultSessionsDir, describeStatus, listLiveSessions } from "./claude-code/registry.ts";
import { focusSession } from "./claude-code/focus.ts";
import { hostAppOf, replyToSession } from "./claude-code/reply.ts";
import { probeFocusedElement, sendKeystroke } from "./dictation/focus-paste.ts";
import { ClaudeHooksController } from "./claude-code/hooks-controller.ts";
import {
  DEFAULT_MODEL_NAME,
  findInstalledModel,
  findModelSpec,
  formatBytes,
  downloadModel,
  modelsDir
} from "./dictation/model-installer.ts";
import { MeetingIndicator } from "./meeting/meeting-indicator.ts";
import { MeetingHistoryWindow } from "./meeting/meeting-history-window.ts";
import {
  deriveAssistantState,
  groupSessions,
  IDLE_INPUTS,
  projectOf,
  pushLine,
  sessionCounts,
  type AssistantInputs
} from "./assistant/assistant-state.ts";
import { describeWaiting, isQuestionWait, type WaitingSession } from "./assistant/waiting-speech.ts";
import { reminderText } from "./calendar/reminders.ts";
import { AssistantHomeWindow, type AssistantStrip } from "./assistant/home-window.ts";
import { glowFor, widgetCards } from "./assistant/ambient.ts";
import { GlowFrame, MiniWidget } from "./assistant/ambient-windows.ts";
import { assistantHotkeyFromEnv, findAcceleratorConflict } from "./assistant/strip.ts";
import { AssistantDispatcher, listProcesses } from "./assistant/dispatcher.ts";
import { GENERAL_NAME, screenshotCommand, withoutHostSessionEnv } from "./assistant/dispatcher-files.ts";
import { isUnderRoots, parseRoutingRoots } from "./claude-code/context-router.ts";
import {
  classifyPermissionAnswer,
  describePermission,
  describeQuestion,
  isVoicePermission,
  matchQuestionAnswer,
  parsePermissionRequest,
  permissionHookOutput,
  questionHookOutput,
  voiceQuestion
} from "./claude-code/permission-voice.ts";
import type { SpokenSessionEvent } from "./claude-code/session-notifier.ts";
import { createCallPresence, warmUpMicUsers } from "./presence/call-presence.ts";
import { completeOnce } from "./claude-code/answer-summary.ts";
import {
  buildGreetingRequest,
  cleanGreeting,
  greetingFallback,
  meetingToday,
  readLastGreeted,
  shouldGreet,
  writeLastGreeted
} from "./assistant/greeting.ts";
import { matchSleepCommand } from "./assistant/sleep.ts";
import { MeetingLibrary } from "./meeting/meeting-library.ts";
import { MeetingRecorder, type MeetingMode } from "./meeting/meeting-recorder.ts";
import type { CalendarService } from "./calendar/calendar-service.ts";
import { calendarTrayItem, createCalendarService } from "./calendar/calendar-ui.ts";
import { broadcastUiLanguage, registerUiLanguageIpc, t, uiLanguage } from "./i18n/ui-language.ts";
import { runPostInstallPermissionCheck } from "./permissions/post-install-check.ts";
import { applySettingsToEnv, loadSettings, saveSettings, type MarshalSettings } from "./settings-store.ts";
import { legacyUserDataPath, migrateLegacyUserData } from "./user-data-migration.ts";
import { buildSetupHealth, type BuildInfo, type SetupHealthSummary } from "./setup-health.ts";
import { IDLE_BUDGET_BYTES, measureFootprint } from "./perf/footprint.ts";
import { ClipboardMonitor, DEDICATED_HOTKEY as TRANSLATOR_HOTKEY } from "./translator/clipboard-monitor.ts";
import { TranslatorHistoryStore, type HistoryItem } from "./translator/history-store.ts";
import {
  TranslatorGlossaryStore,
  buildGlossaryEntry,
  type GlossaryEntry
} from "./translator/glossary-store.ts";
import { insertTranslation } from "./translator/insert-service.ts";
import { MAX_SENTENCE_CHARS } from "./translator/backends/alternatives.ts";
import { LANGUAGES, resolveLangCode, resolveSourceLang } from "./translator/languages.ts";
import type { LangCode, SourceLang } from "./translator/languages.ts";
import { DEFAULT_LAYOUT_SWITCH_HOTKEY, LayoutSwitcher } from "./translator/layout-switcher.ts";
import {
  TranslatorService,
  type Formality,
  type TranslatorFallbackNotice
} from "./translator/translator-service.ts";
import { TranslatorWindow } from "./translator/translator-window.ts";
import { decideHotkeyAction } from "./translator/window-policy.ts";
import { ScreenshotService } from "./translator/screenshot-service.ts";
import { shutdownUiohookForQuit } from "./uiohook-lifecycle.ts";
import { getSharedLocalBridgeServer } from "../agent/bridge/local-bridge-server.ts";
import { withUserBinDirs } from "./user-path.ts";

// Load .env from project root before anything else. `override: false` matches
// the previous custom parser's behaviour — existing environment variables win
// over values declared in the .env file.
const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const projectRootDir = path.resolve(desktopDistDir, "..", "..");
const envPath = path.join(projectRootDir, ".env");
// What Marshal was started with, before its .env: apps it launches (Terminal) inherit this, not its keys (#322),
// and not the session env of a Claude desktop session that started Marshal (#388).
const launchEnv: NodeJS.ProcessEnv = withoutHostSessionEnv(process.env);
loadDotenv({ path: envPath, override: false });
process.env.PATH = withUserBinDirs(process.env.PATH, app.getPath("home"));
const preloadPath = path.join(desktopDistDir, "preload.cjs");
const appIconPath = path.join(projectRootDir, "assets", "icon.png");
const execFileAsync = promisify(execFile);

if (app.isPackaged) {
  // The backend utility process inherits this env; without it agent state resolves against cwd "/" (#206, #233).
  process.env.MARSHAL_DATA_DIR ??= app.getPath("userData");
}
const backendClient = new DesktopBackendClient();

let translatorService: TranslatorService | null = null;
let translatorWindow: TranslatorWindow | null = null;
let screenshotService: ScreenshotService | null = null;
let captureService: CaptureService | null = null;
let captureWindow: CaptureWindow | null = null;
let captureHistoryWindow: CaptureHistoryWindow | null = null;
let captureArchive: CaptureArchive | null = null;
// The archive entry the open editor is backed by, so annotating and then
// copying updates that one entry instead of leaving the original plus a
// near-duplicate. Null when the editor is closed, or when it holds an image
// that came from the user's own capture folder (#225).
let currentArchiveEntry: { path: string; kind: string } | null = null;
let floatingToolbar: FloatingToolbar | null = null;
let updateChecker: UpdateChecker | null = null;
let updateCheckTimer: NodeJS.Timeout | null = null;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const UPDATE_CHECK_STARTUP_DELAY_MS = 60 * 1000; // 60 seconds after boot
let videoRecorder: VideoRecorder | null = null;
let recordingIndicator: RecordingIndicator | null = null;
let isRecording = false;
let gifDialog: GifDialog | null = null;
let lastRecordingPath: string | null = null;
let clipboardMonitor: ClipboardMonitor | null = null;
let layoutSwitcher: LayoutSwitcher | null = null;
let translatorHistory: TranslatorHistoryStore | null = null;
let translatorGlossary: TranslatorGlossaryStore | null = null;
// In-flight whisper model download. The model is a 1.5 GB out-of-band asset
// (see dictation/model-installer.ts), so the tray shows progress and offers
// a cancel instead of blocking on a modal.
let modelDownload: { name: string; percent: number; abort: AbortController } | null = null;
let dictationService: DictationService | null = null;
let dictationIndicator: DictationIndicator | null = null;
let isDictating = false;
let meetingRecorder: MeetingRecorder | null = null;
let meetingIndicator: MeetingIndicator | null = null;
let meetingHistoryWindow: MeetingHistoryWindow | null = null;
let assistantHome: AssistantHomeWindow | null = null;
let glowFrame: GlowFrame | null = null;
let miniWidget: MiniWidget | null = null;
let assistantInputs: AssistantInputs = { ...IDLE_INPUTS, asleep: loadSettings().assistantAsleep };
let assistantLines: string[] = [];
let sessionsWatcher: fs.FSWatcher | null = null;
let sessionsRefresh: NodeJS.Timeout | null = null;
let calendarService: CalendarService | null = null;
let isMeetingRecording = false;
const SESSIONS_REFRESH_DEBOUNCE_MS = 250;
// Shared by speech and the open mic (#359, #375): the probe caches its answer for 2 s.
const isOnCall = createCallPresence();
// A question queued behind other phrases (or held by captions) is stale after this.
const ANSWER_QUIET_WAIT_MS = 30_000;
// The hook gives up at 58 s (curl) / 60 s (Claude Code); answer well before that.
const PERMISSION_DEADLINE_MS = 50_000;
// The prompt that follows an unanswered voice question needs no second announcement.
const PERMISSION_ASKED_QUIET_MS = 60_000;
const WAITING_COALESCE_MS = 2_000;
const WAITING_SPEECH_KEY = "session:waiting";
type WaitingSignalEntry = { project: string; confirmation: boolean; message: string };
const waitingSignals = new Map<string, WaitingSignalEntry>();
const lastWaitingSignal = new Map<string, WaitingSignalEntry>();
const waitingProjectsUnspoken = new Set<string>();
let waitingFlush: NodeJS.Timeout | null = null;
let permissionTurn: Promise<unknown> = Promise.resolve();
const permissionAskedAt = new Map<string, number>();
// Voices, the first calendar sync and the mic probe settle before the greeting.
const GREETING_DELAY_MS = 8_000;
// Counted on hook events and while the home window is open, never polled (#281).
let waitingSessionCount = 0;
// One footprint measurement per opening of the home window (#309).
let assistantMemory: AssistantStrip["memory"] = null;
let assistantHotkey: string | null = null;
const MEETING_TOGGLE_ACCELERATOR = "CommandOrControl+Alt+Shift+M";
let captionsService: LiveCaptionsService | null = null;
let speechService: SpeechService | null = null;
// Accelerators come from Settings (applied to the env on save) and are
// re-registered on every save, so the tray labels read them live.
let captionsAccelerators: { toggle: string; ocr: string } = {
  toggle: DEFAULT_CAPTIONS_HOTKEY,
  ocr: DEFAULT_CAPTIONS_OCR_HOTKEY
};

let tray: Tray | null = null;
let claudeHooks: ClaudeHooksController | null = null;
let assistantDispatcher: AssistantDispatcher | null = null;
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
      openAssistantHome();
    });

    await app.whenReady();
    if (process.platform === "darwin") {
      app.setActivationPolicy("accessory");
    }

    // 0.3.x renamed the userData directory from the npm package name to the
    // product name (#158). Carry a previous install's settings, .env and
    // stores over once, before anything below reads them.
    {
      const userData = app.getPath("userData");
      const migration = migrateLegacyUserData(userData, legacyUserDataPath(userData));
      if (migration.performed) {
        console.log(`[marshal] userData migrated from ${migration.from}: ${migration.copied.join(", ")}`);
      }
    }

    // Second-pass .env load — production-only fallback. The top-of-file
    // `loadDotenv()` resolves to `<projectRoot>/.env`, which lives inside
    // app.asar in packaged builds and is therefore unreadable. The user's
    // writable spot is app.getPath("userData") — drop a `.env` there and
    // values like MARSHAL_API_KEY get picked up by the next launch.
    // Available only after app.whenReady() because getPath("userData") is.
    const userDataEnvPath = path.join(app.getPath("userData"), ".env");
    if (fs.existsSync(userDataEnvPath)) {
      const before = process.env.MARSHAL_API_KEY ? "present" : "absent";
      loadDotenv({ path: userDataEnvPath, override: false });
      const after = process.env.MARSHAL_API_KEY ? "present" : "absent";
      console.log(`[marshal] loaded .env from ${userDataEnvPath} (MARSHAL_API_KEY ${before}→${after})`);
    } else {
      console.log(`[marshal] no .env at ${userDataEnvPath} — running with project-root .env only`);
    }

    // Settings override .env values. Must be applied BEFORE the backend utility
    // process forks so the child inherits the correct env.
    let initialSettings = loadSettings();
    applySettingsToEnv(initialSettings);
    initialSettings = applyLaunchAtLogin(initialSettings);

    registerIpcHandlers();
    createTray();
    // Marshal opens no window at start; the smoke test needs one to look at.
    if (process.env.MARSHAL_E2E_OPEN_HOME === "1") openAssistantHome();
    scheduleTrayRefresh();

    // `MARSHAL_HEADLESS=1` disables every subsystem that needs real hardware,
    // user permissions, or a long-running native helper. It exists for the
    // CI smoke test — a headless GitHub runner cannot grant Screen Recording
    // / Accessibility, and uiohook-napi / Swift recorders deadlock when
    // their TCC prompts time out. Skipping these branches keeps the IPC
    // surface fully testable.
    if (process.env.MARSHAL_HEADLESS !== "1") {
      logPermissionStatus();
      void runPostInstallPermissionCheck({
        currentVersion: app.getVersion(),
        language: uiLanguage(),
        loadSettings,
        saveSettings,
        queryPermissions: () => ({
          platform: process.platform,
          microphoneStatus: process.platform === "darwin"
            ? systemPreferences.getMediaAccessStatus("microphone")
            : "granted",
          screenStatus: process.platform === "darwin"
            ? systemPreferences.getMediaAccessStatus("screen")
            : "granted",
          accessibilityTrusted: process.platform === "darwin"
            ? systemPreferences.isTrustedAccessibilityClient(false)
            : true
        }),
        showMessageBox: (options) => dialog.showMessageBox(options),
        openExternal: (url) => shell.openExternal(url)
      }).catch((err) => {
        console.warn("[marshal] post-install permission check failed:", err);
      });
      initTranslator();
      initCapture();
      initDictation();
      initMeetingRecorder();
      initLiveCaptions();
      claudeHooks = new ClaudeHooksController(app.getPath("userData"), announceToAssistant, () => countWaitingSessions(), speakSessionEvent, answerPermissionByVoice);
      void claudeHooks.startIfInstalled();
      initCalendar();
      initSpeech();
      initAssistantDispatcher();
      registerAssistantHotkey();
      initAmbient();
      void initExtensionBridge();
      initUpdater();
      if (!Object.keys(process.env).some((key) => key.startsWith("MARSHAL_E2E"))) {
        setTimeout(() => void greetOnLaunch(), GREETING_DELAY_MS).unref();
      }
    }

    app.on("activate", () => {
      openAssistantHome();
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
  registerUiLanguageIpc();
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
  handleIpc("marshal:select-directory", async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent) return null;
    const result = await dialog.showOpenDialog(parent, {
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
  handleIpc("marshal:calendar:status", () => calendarStatus());
  handleIpc("marshal:calendar:set-url", (_event, url: unknown) => {
    if (!calendarService) throw new Error("Calendar is not available in this mode");
    calendarService.setUrl(typeof url === "string" ? url : "");
    return calendarStatus();
  });
  handleIpc("marshal:get-setup-health", () => getSetupHealth());
  handleIpc("marshal:claude-code-hooks-get", () => claudeHooks?.state());
  handleIpc("marshal:claude-code-hooks-set", (_event, installed: unknown) =>
    claudeHooks?.setInstalled(installed === true));
  handleIpc("marshal:check-for-updates", () => runManualUpdateCheck());
  handleIpc("marshal:check-for-updates-silent", () => runSilentUpdateCheck());
  handleIpc("marshal:start-update-install", (event) => runUpdateInstall(event.sender));
  handleIpc("marshal:open-external", (_event, url: string) => {
    if (typeof url !== "string" || !/^https?:\/\//u.test(url)) {
      throw new Error("Refused to open non-http URL");
    }
    void shell.openExternal(url);
    return { ok: true };
  });
  handleIpc("marshal:get-dictation-defaults", () => ({ prompt: DEFAULT_DICTATION_PROMPT }));
  handleIpc("marshal:get-captions-defaults", () => ({ prompt: DEFAULT_CAPTIONS_PROMPT }));
  // Stop button on the floating dictation indicator (#98). The indicator
  // renderer is the only legitimate caller; the action is idempotent so a
  // double-click while transcription is already in flight is a no-op.
  handleIpc("marshal:dictation-stop", () => {
    if (dictationService?.isCurrentlyRecording()) {
      dictationService.stopRecording();
    }
    return { ok: true };
  });
  handleIpc("marshal:dictation-list-mics", async () => {
    try {
      const devices = await listMicrophones();
      return { ok: true, devices };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, devices: [], error: message };
    }
  });
  handleIpc("marshal:meeting-stop", async () => {
    await stopMeetingRecording();
    return { ok: true };
  });
  handleIpc("marshal:meeting-history:refresh", () => {
    meetingHistoryWindow?.refresh();
    return { ok: true };
  });
  handleIpc("marshal:meeting-history:reveal", (_event, input: { path: string }) => {
    return meetingHistoryWindow?.reveal(input.path) ?? { ok: false, error: "Meeting recorder not initialized" };
  });
  handleIpc("marshal:meeting-history:reveal-folder", async () => {
    const folder = MeetingRecorder.meetingsDir(app.getPath("userData"));
    await fs.promises.mkdir(folder, { recursive: true });
    const failure = await shell.openPath(folder);
    return failure ? { ok: false, error: failure } : { ok: true };
  });
  handleIpc("marshal:meeting-history:finish", async (_event, input: { id: string }) => {
    return (await meetingHistoryWindow?.finish(input.id)) ?? { ok: false, error: "Meeting recorder not initialized" };
  });
  handleIpc("marshal:meeting-history:summarize", async (_event, input: { id: string; language: string }) => {
    return (await meetingHistoryWindow?.summarize(input.id, input.language)) ?? { ok: false, error: "Meeting recorder not initialized" };
  });
  handleIpc("marshal:meeting-history:cancel-notes", (_event, input: { id: string }) => {
    return meetingHistoryWindow?.cancelNotes(input.id) ?? false;
  });
  handleIpc("marshal:meeting-history:read-notes", async (_event, input: { id: string }) => {
    return (await meetingHistoryWindow?.readNotes(input.id)) ?? null;
  });
  handleIpc("marshal:meeting-history:open-notes-file", async (_event, input: { id: string; file: "notes" | "transcript" }) => {
    return (await meetingHistoryWindow?.openNotesFile(input.id, input.file)) ?? { ok: false, error: "Meeting recorder not initialized" };
  });
  handleIpc("marshal:meeting-history:trash", async (_event, input: { id: string }) => {
    return (await meetingHistoryWindow?.trash(input.id)) ?? { ok: false, error: "Meeting recorder not initialized" };
  });
  handleIpc("marshal:meeting-history:close", () => {
    meetingHistoryWindow?.close();
    return { ok: true };
  });
  handleIpc("marshal:assistant:action", (_event, input: { name: string }) => {
    runAssistantAction(input?.name);
    return { ok: true };
  });
  handleIpc("marshal:assistant:widget-move", (_event, input: { x?: unknown; y?: unknown; done?: unknown } | undefined) => {
    if (typeof input?.x !== "number" || typeof input.y !== "number") return { ok: false };
    miniWidget?.moveTo({ x: input.x, y: input.y }, input.done === true);
    return { ok: true };
  });
  handleIpc("marshal:assistant:close", () => {
    assistantHome?.close();
    return { ok: true };
  });
  handleIpc("marshal:assistant:focus-session", async (_event, input: { pid?: unknown } | undefined) => {
    const pid = input?.pid;
    // Only a pid the registry lists right now: the renderer must not pick arbitrary processes.
    if (typeof pid !== "number" || !listLiveSessions().some((session) => session.pid === pid)) {
      return { ok: false, error: t("session.gone") };
    }
    const focused = await focusSession(pid);
    return focused ? { ok: true, focused } : { ok: false, error: t("session.focusFailed") };
  });
  // What the agent backend reads from the env (applySettingsToEnv).
  const BACKEND_SETTING_KEYS = ["bridgeMode", "claudeModel", "codexModel"] as const;
  handleIpc("marshal:update-settings", async (_event, next: Partial<MarshalSettings>) => {
    const before = loadSettings();
    let saved = saveSettings(next ?? {});
    applySettingsToEnv(saved);
    saved = applyLaunchAtLogin(saved);
    restartDictation();
    syncCalendar();
    void syncAssistantDispatcher();
    // Captions read their config from the env on the next start; only the
    // accelerators need rebinding now (#179).
    registerCaptionsShortcuts();
    // Hot-swap the translator so the new choice takes effect without waiting
    // for a full app restart. Apply bridge FIRST so "auto" resolves against
    // the up-to-date provider before setBackend re-reads the choice.
    translatorService?.setBridgeMode(saved.bridgeMode);
    translatorService?.setBackend(saved.translatorBackend);
    translatorService?.setLanguagePair(
      saved.translatorSourceLang,
      saved.translatorTargetLang,
      saved.translatorFormality
    );
    broadcastUiLanguage();
    // The ambient toggles live in Settings now (#341) and apply on save.
    if (saved.assistantWidget) miniWidget?.open();
    else miniWidget?.close();
    updateAmbient();
    countWaitingSessions();
    pushAssistantStrip();
    // Only the reasoning bridge reads provider and model; anything else
    // restarting it would drop a running agent task for nothing (#317).
    if (BACKEND_SETTING_KEYS.some((key) => saved[key] !== before[key])) await backendClient.restart();
    return saved;
  });

  // Translator IPC handlers
  // Requests that originate in the translator window resolve through the
  // returned promise — the renderer already owns its loading/result state and
  // sequences overlapping translate-as-you-type calls itself. Broadcasting a
  // `translator-result` event here would race with that. The main-initiated
  // paths (hotkeys, OCR) still broadcast, see initTranslator().
  handleIpc(
    "marshal:translator-translate-text",
    async (_event, payload: TranslateTextRequest) => {
      const { service } = ensureTranslator();
      const { text, targetLang, options } = normalizeTranslateRequest(payload);
      return service.translateText(text, targetLang, options);
    }
  );

  handleIpc(
    "marshal:translator-translate-image",
    async (_event, payload: TranslateImageRequest) => {
      const { service } = ensureTranslator();
      const { targetLang, options } = normalizeTranslateRequest(payload);
      const image = prepareTranslatorImage(payload.base64, payload.mimeType || "image/png");
      const result = await service.translateImage(image.base64, image.mimeType, targetLang, options);
      pushHistory({
        text: "",
        translation: result.translation,
        sourceLang: result.sourceLang,
        targetLang: result.targetLang,
        mode: "image",
        timestamp: Date.now()
      });
      return result;
    }
  );

  // Alternatives for one clicked word (#146). The renderer resolves the word
  // and the sentence around it, so this stays a sentence-sized request no
  // matter how long the translation on screen is.
  handleIpc(
    "marshal:translator-alternatives",
    async (_event, payload: AlternativesIpcRequest) => {
      const { service } = ensureTranslator();
      const settings = loadSettings();
      const sentence = typeof payload?.sentence === "string" ? payload.sentence : "";
      const word = typeof payload?.word === "string" ? payload.word : "";
      if (!sentence || !word) return { alternatives: [] };

      const request = {
        sentence,
        word,
        wordOffset: typeof payload?.wordOffset === "number" ? payload.wordOffset : 0,
        targetLang: resolveLangCode(payload?.targetLang, settings.translatorTargetLang),
        options: {
          sourceLang: resolveSourceLang(payload?.sourceLang, settings.translatorSourceLang),
          formality: normalizeFormality(payload?.formality ?? settings.translatorFormality)
        }
      };
      const sourceText = typeof payload?.sourceText === "string" ? payload.sourceText.trim() : "";
      return service.suggestAlternatives(
        sourceText ? { ...request, sourceText: sourceText.slice(0, MAX_SENTENCE_CHARS) } : request
      );
    }
  );

  // The language registry is defined once, in the main process, and handed to
  // the renderer so the picker can never offer a language the prompts don't
  // know about.
  handleIpc("marshal:translator-languages", () => {
    const settings = loadSettings();
    return {
      languages: LANGUAGES,
      sourceLang: settings.translatorSourceLang,
      targetLang: settings.translatorTargetLang,
      formality: settings.translatorFormality,
      pinned: translatorWindow?.isPinned() ?? false
    };
  });

  // Persisted so the hotkey paths translate in the direction the user last
  // picked in the window, and so the next open starts there.
  handleIpc(
    "marshal:translator-set-pair",
    (_event, payload: { sourceLang?: unknown; targetLang?: unknown; formality?: unknown }) => {
      const sourceLang = resolveSourceLang(payload?.sourceLang, "auto");
      const targetLang = resolveLangCode(payload?.targetLang, "uk");
      const formality = normalizeFormality(payload?.formality);
      const saved = saveSettings({
        translatorSourceLang: sourceLang,
        translatorTargetLang: targetLang,
        translatorFormality: formality
      });
      applySettingsToEnv(saved);
      translatorService?.setLanguagePair(sourceLang, targetLang, formality);
      return { sourceLang, targetLang, formality };
    }
  );

  // The renderer owns the source field, so it tells the window when there is
  // work in progress. Without this the window cannot tell a half-typed
  // sentence from an empty glance, and hides either way (#166).
  // The editor floats by default because an LSUIElement app cannot raise a
  // window that slipped behind another one (#168). Toggleable, because
  // floating is wrong when you need to read from the window underneath.
  handleIpc("marshal:capture-always-on-top", (_event, alwaysOnTop: boolean) => {
    const next = alwaysOnTop === true;
    saveSettings({ captureEditorAlwaysOnTop: next });
    return captureWindow?.setAlwaysOnTop(next) ?? next;
  });

  handleIpc("marshal:capture-always-on-top-get", () =>
    captureWindow?.isAlwaysOnTop() ?? loadSettings().captureEditorAlwaysOnTop
  );

  handleIpc("marshal:translator-content", (_event, hasContent: boolean) => {
    translatorWindow?.setHasContent(hasContent === true);
    return hasContent === true;
  });

  handleIpc("marshal:translator-pin", (_event, pinned: boolean) => {
    if (!translatorWindow) {
      throw new Error("Translator window is not initialized.");
    }
    return translatorWindow.setPinned(pinned === true);
  });

  // Insert the finished translation into the app the user came from. Hiding
  // the window is what hands focus back, so it happens inside the service.
  handleIpc("marshal:translator-insert", async (_event, text: string) => {
    if (!translatorWindow) {
      throw new Error("Translator window is not initialized.");
    }
    const window = translatorWindow;
    return insertTranslation(typeof text === "string" ? text : "", {
      hideWindow: () => window.hide()
    });
  });

  handleIpc("marshal:translator-history-push", (_event, item: Partial<HistoryItem>) => {
    pushHistory({
      text: typeof item?.text === "string" ? item.text : "",
      translation: typeof item?.translation === "string" ? item.translation : "",
      sourceLang: typeof item?.sourceLang === "string" ? item.sourceLang : "",
      targetLang: typeof item?.targetLang === "string" ? item.targetLang : "",
      mode: item?.mode === "image" ? "image" : "text",
      timestamp: Date.now()
    });
    return translatorHistory?.list() ?? [];
  });

  // Fixed terms. Every mutation pushes the fresh list into the service, so the
  // hotkey paths use the same glossary as the window without a restart.
  handleIpc("marshal:translator-glossary-list", () => translatorGlossary?.list() ?? []);

  handleIpc(
    "marshal:translator-glossary-add",
    (_event, payload: { term?: unknown; targetLang?: unknown; translation?: unknown }) => {
      if (!translatorGlossary) throw new Error("Translator glossary is not initialized.");
      const entry = buildGlossaryEntry(payload?.term, payload?.targetLang, payload?.translation);
      if (!entry) throw new Error(t("glossary.needsTerm"));
      const next = translatorGlossary.upsert(entry);
      translatorService?.setGlossary(next);
      return next;
    }
  );

  handleIpc("marshal:translator-glossary-remove", (_event, term: string) => {
    if (!translatorGlossary) throw new Error("Translator glossary is not initialized.");
    const next = translatorGlossary.remove(typeof term === "string" ? term : "");
    translatorService?.setGlossary(next);
    return next;
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
    openTranslator();
  });

  handleIpc("marshal:translator-expand", () => {
    translatorWindow?.expand();
  });

  handleIpc("marshal:translator-fit", (_event, height: unknown) => {
    const value = Number(height);
    if (Number.isFinite(value)) translatorWindow?.fitCompact(value);
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
      title: t("dialog.saveCapture"),
      defaultPath: path.join(app.getPath("desktop"), defaultName),
      filters: [{ name: t("dialog.pngImage"), extensions: ["png"] }]
    });
    if (result.canceled || !result.filePath) return { path: null };
    fs.writeFileSync(result.filePath, Buffer.from(input.base64, "base64"));
    keepInArchive(input.base64);
    return { path: result.filePath };
  });

  handleIpc("marshal:capture-save-quick", async (_event, input: { base64: string }) => {
    const settings = loadSettings();
    const folder = settings.captureDefaultFolder || app.getPath("desktop");
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    const filePath = path.join(folder, defaultCaptureFilename());
    fs.writeFileSync(filePath, Buffer.from(input.base64, "base64"));
    keepInArchive(input.base64);
    captureHistoryWindow?.refresh();
    return { path: filePath };
  });

  handleIpc("marshal:capture-copy", (_event, input: { base64: string }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(input.base64, "base64"));
    clipboard.writeImage(image);
    // Copy is a terminal action: the user has what they came for. Keep the
    // annotated version in history first, then get the window out of the way
    // — it floats above everything until it closes (#224).
    keepInArchive(input.base64);
    notifyCaptureCopied();
    captureWindow?.close();
    currentArchiveEntry = null;
    return { ok: true, closed: true };
  });

  // "Show Claude the bug" (#265): the annotated image goes into history and the
  // dispatcher routes the note plus its path to a session. Terminal, like Copy.
  handleIpc("marshal:capture-send-to-claude", (_event, input: { base64: string; note: string }) => {
    keepInArchive(input.base64);
    let imagePath = currentArchiveEntry?.path ?? null;
    if (!imagePath) {
      imagePath = path.join(app.getPath("temp"), defaultCaptureFilename());
      fs.writeFileSync(imagePath, Buffer.from(input.base64, "base64"));
    }
    captureWindow?.close();
    currentArchiveEntry = null;
    enableAssistantOnce();
    assistantDispatcher?.submit(screenshotCommand(String(input.note ?? ""), imagePath));
    return { ok: true, closed: true };
  });

  handleIpc("marshal:capture-pin", (_event, input: { base64: string }) => {
    openPinnedWindow(input.base64);
    keepInArchive(input.base64);
    return { ok: true };
  });

  handleIpc("marshal:capture-close", () => {
    captureWindow?.close();
    currentArchiveEntry = null;
    return { ok: true };
  });

  // ── Capture history ──
  handleIpc("marshal:capture-history:refresh", () => {
    captureHistoryWindow?.refresh();
    return { ok: true };
  });
  handleIpc("marshal:capture-history:open-in-editor", async (_event, input: { path: string }) => {
    if (!captureHistoryWindow || !captureWindow) return { ok: false, error: "Capture not initialized" };
    const image = await captureHistoryWindow.readImage(input.path);
    if (!image) return { ok: false, error: t("history.cannotRead") };
    // Pass kind: "area" so the editor sets the right title. width/height get
    // re-read from the decoded base64 inside the editor itself.
    captureWindow.openEditor({
      capture: { base64: image.base64, width: image.width, height: image.height, kind: "area" }
    });
    // Re-editing an archived capture updates that entry. An image from the
    // user's own capture folder is left alone — a later copy records a fresh
    // archive entry rather than rewriting their file.
    currentArchiveEntry = captureArchive?.contains(input.path)
      ? { path: input.path, kind: "area" }
      : null;
    return { ok: true };
  });
  handleIpc("marshal:capture-history:open-external", async (_event, input: { path: string }) => {
    if (!captureHistoryWindow) return { ok: false, error: "Capture not initialized" };
    return await captureHistoryWindow.revealOrOpen(input.path, "open");
  });
  handleIpc("marshal:capture-history:reveal", async (_event, input: { path: string }) => {
    if (!captureHistoryWindow) return { ok: false, error: "Capture not initialized" };
    return await captureHistoryWindow.revealOrOpen(input.path, "reveal");
  });
  handleIpc("marshal:capture-history:reveal-folder", () => {
    const folder = loadSettings().captureDefaultFolder || path.join(app.getPath("home"), "Desktop");
    shell.openPath(folder).catch(() => undefined);
    return { ok: true };
  });
  handleIpc("marshal:capture-history:close", () => {
    captureHistoryWindow?.close();
    return { ok: true };
  });

  // ── Floating toolbar ──
  handleIpc("marshal:toolbar:capture-area", () => {
    void runCapture("area");
    return { ok: true };
  });
  handleIpc("marshal:toolbar:capture-fullscreen", () => {
    void runCapture("fullscreen");
    return { ok: true };
  });
  handleIpc("marshal:toolbar:toggle-recording", async () => {
    if (isRecording) {
      await stopVideoRecording();
    } else {
      await toggleVideoRecording("fullscreen");
    }
    return { ok: true };
  });
  handleIpc("marshal:toolbar:open-gif", () => {
    void openGifConverter();
    return { ok: true };
  });
  handleIpc("marshal:toolbar:open-history", () => {
    captureHistoryWindow?.open();
    return { ok: true };
  });
  handleIpc("marshal:toolbar:recording-state", () => ({ recording: isRecording }));
  handleIpc("marshal:toolbar:close", () => {
    floatingToolbar?.close();
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

  handleIpc("marshal:gif-start", async (_event, opts: {
    inputPath: string;
    fps: number;
    width: number;
    loop: boolean;
  }) => {
    if (!gifDialog) throw new Error("GIF dialog not initialised");
    const outputPath = opts.inputPath.replace(/\.[^./]+$/u, "") + ".gif";
    try {
      await GifEncoder.convert(
        { inputPath: opts.inputPath, outputPath, fps: opts.fps, width: opts.width, loop: opts.loop },
        (progress) => gifDialog?.sendProgress(progress)
      );
      gifDialog.sendDone(outputPath);
      if (Notification.isSupported()) {
        const name = outputPath.split("/").pop() ?? outputPath;
        const notif = new Notification({
          title: t("notify.gifSaved"),
          body: name,
          silent: true
        });
        notif.on("click", () => void shell.showItemInFolder(outputPath));
        notif.show();
      }
      return { outputPath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      gifDialog.sendError(message);
      throw new Error(message);
    }
  });

  handleIpc("marshal:gif-close", () => {
    gifDialog?.close();
    return { ok: true };
  });
}

async function openGifConverter(): Promise<void> {
  if (!gifDialog) return;

  if (!GifEncoder.isAvailable()) {
    if (Notification.isSupported()) {
      new Notification({
        title: t("notify.ffmpegMissing"),
        body: t("notify.ffmpegMissingBody"),
        silent: true
      }).show();
    }
    return;
  }

  let initialPath = lastRecordingPath;
  if (!initialPath || !fs.existsSync(initialPath)) {
    const result = await dialog.showOpenDialog({
      title: t("dialog.pickVideo"),
      defaultPath: app.getPath("desktop"),
      properties: ["openFile"],
      filters: [{ name: t("dialog.video"), extensions: ["mov", "mp4", "m4v"] }]
    });
    if (result.canceled || result.filePaths.length === 0) return;
    initialPath = result.filePaths[0];
  }

  gifDialog.open({ inputPath: initialPath });
}

/** Long enough for the window server to drop hidden windows from the next frame. */
const CAPTURE_HIDE_SETTLE_MS = 150;

/**
 * Hides every visible Marshal window so none of them lands in the shot, and
 * returns a function that brings them back without taking focus (#342).
 * Content-protected windows (captions, glow, mini widget) are already absent
 * from screen captures and stay put. Hiding does not activate Marshal, so a
 * menu open in another app survives until the screen has been grabbed.
 */
async function hideOwnWindows(): Promise<() => void> {
  const hidden = BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && win.isVisible() && !win.isContentProtected()
  );
  for (const win of hidden) win.hide();
  if (hidden.length > 0) await new Promise<void>((r) => setTimeout(r, CAPTURE_HIDE_SETTLE_MS));
  return () => {
    for (const win of hidden.splice(0)) if (!win.isDestroyed()) win.showInactive();
  };
}

async function runCapture(kind: "area" | "fullscreen"): Promise<void> {
  if (!captureService || !captureWindow) return;

  const restoreWindows = await hideOwnWindows();
  try {
    let result: CaptureResult | null;
    try {
      result = kind === "area" ? await captureService.captureArea() : await captureService.captureFullscreen();
    } finally {
      // Before the editor opens, so a restored floating window does not cover it.
      restoreWindows();
    }
    if (!result) return;
    openEditorWithArchive(result);
  } catch (err) {
    if (Notification.isSupported()) {
      new Notification({
        title: t("notify.captureFailed"),
        body: err instanceof Error ? err.message : String(err),
        silent: true
      }).show();
    }
    console.error("[marshal] capture failed:", err);
  }
}

/**
 * Experimental: ask the user to pick a region, then drive the page through a
 * series of scrolls + frame grabs and stitch the result. Saves the final PNG
 * to the user's capture folder and opens it in the annotation editor.
 *
 * Reuses the `pickArea` overlay so the user gets the same selection UX as a
 * regular area capture. After picking, we wait ~600 ms before starting the
 * scroll-capture subprocess so the overlay window is fully torn down — its
 * compositor stack must be gone before the cursor warp + scroll events land,
 * otherwise the very first frame will catch the overlay.
 */
async function runScrollingCapture(): Promise<void> {
  if (!captureWindow) return;
  if (!(await ScrollCapture.isAvailable())) {
    if (Notification.isSupported()) {
      new Notification({
        title: t("notify.scrollUnavailable"),
        body: t("notify.scrollUnavailableBody"),
        silent: true
      }).show();
    }
    return;
  }

  const restoreWindows = await hideOwnWindows();
  try {
    const pick = await pickArea({ preloadPath });
    if (!pick) return;

    // Let the overlay window unmount; scroll events fire at HID level, so
    // any lingering covers (even transparent) catch the cursor warp.
    await new Promise<void>((r) => setTimeout(r, 600));

    const settings = loadSettings();
    const captureFolder = settings.captureDefaultFolder || path.join(app.getPath("home"), "Desktop");
    await fs.promises.mkdir(captureFolder, { recursive: true });
    const outName = `Marshal ${new Date().toISOString().replace(/[:.]/gu, "-")} (scrolling).png`;
    const outPath = path.join(captureFolder, outName);

    const service = new ScrollCapture();
    const result = await service.run({
      area: {
        x: Math.round(pick.region.x),
        y: Math.round(pick.region.y),
        width: Math.round(pick.region.width),
        height: Math.round(pick.region.height)
      },
      outPath
    });
    restoreWindows();

    // Open the stitched PNG in the annotation editor for cropping / markup.
    // Read the real pixel size back out of the PNG — the editor sizes its
    // window from these numbers, and hardcoded zeroes collapsed every
    // scrolling capture to the 780×560 minimum (#134).
    const pngBytes = await fs.promises.readFile(result.outPath);
    const stitched = nativeImage.createFromBuffer(pngBytes);
    const stitchedSize = stitched.getSize();
    captureWindow.openEditor({
      capture: {
        base64: pngBytes.toString("base64"),
        width: stitchedSize.width,
        height: stitchedSize.height,
        kind: "area"
      }
    });

    if (Notification.isSupported()) {
      new Notification({
        title: t("notify.scrollSaved"),
        body: t(result.settledEarly ? "notify.scrollSavedBottom" : "notify.scrollSavedBody", { name: outName, frames: result.frameCount }),
        silent: true
      }).show();
    }
  } catch (err) {
    if (Notification.isSupported()) {
      new Notification({
        title: t("notify.scrollFailed"),
        body: err instanceof Error ? err.message : String(err),
        silent: true
      }).show();
    }
    console.error("[marshal] scrolling capture failed:", err);
  } finally {
    restoreWindows();
  }
}

/**
 * Opens the annotation editor and archives the untouched capture first, so a
 * capture that is only ever copied to the clipboard still shows up in history
 * (#225). The archive write is best-effort — a failure logs and the editor
 * opens anyway.
 */
function openEditorWithArchive(capture: CaptureResult): void {
  if (!captureWindow) return;
  const archived = captureArchive?.record(capture.base64, capture.kind) ?? null;
  currentArchiveEntry = archived ? { path: archived, kind: capture.kind } : null;
  captureWindow.openEditor({ capture });
  captureHistoryWindow?.refresh();
}

/**
 * Brings the current archive entry up to date with what the user exported, so
 * one capture session leaves one history entry — holding the annotated version
 * they actually used, not the original they annotated over.
 *
 * Records a fresh entry when there is nothing to update: the editor was opened
 * from the user's capture folder, or the entry has already been pruned.
 */
function keepInArchive(base64: string): void {
  if (!captureArchive) return;
  if (currentArchiveEntry && captureArchive.replace(currentArchiveEntry.path, base64)) {
    captureHistoryWindow?.refresh();
    return;
  }
  const kind = currentArchiveEntry?.kind ?? "area";
  const archived = captureArchive.record(base64, kind);
  currentArchiveEntry = archived ? { path: archived, kind } : null;
  captureHistoryWindow?.refresh();
}

/**
 * The editor's own toast dies with the window, and Copy now closes it — so
 * the confirmation has to outlive it. Silent: this follows a deliberate click.
 */
function notifyCaptureCopied(): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: t("notify.copied"),
    body: t("notify.copiedBody"),
    silent: true
  }).show();
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
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
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

/** Opening the translator starts a Claude CLI process ahead of the first keystroke (#344). */
function openTranslator(): void {
  translatorService?.warmUp();
  translatorWindow?.show();
}

// Claude downsizes anything past 1568 px on the long side anyway; sending a
// full Retina crop only costs upload time. Formats it cannot read go as PNG.
const MAX_TRANSLATOR_IMAGE_EDGE = 1568;
const CLAUDE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function prepareTranslatorImage(base64: string, mimeType: string): { base64: string; mimeType: string } {
  const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
  if (image.isEmpty()) return { base64, mimeType };
  const { width, height } = image.getSize();
  const scale = MAX_TRANSLATOR_IMAGE_EDGE / Math.max(width, height);
  if (scale >= 1 && CLAUDE_IMAGE_TYPES.has(mimeType)) return { base64, mimeType };
  const sized = scale < 1
    ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "best" })
    : image;
  return { base64: sized.toPNG().toString("base64"), mimeType: "image/png" };
}

function ensureTranslator(): { service: TranslatorService; window: TranslatorWindow } {
  if (!translatorService || !translatorWindow) {
    throw new Error("Translator is not initialized.");
  }
  return { service: translatorService, window: translatorWindow };
}

interface TranslateRequestBase {
  sourceLang?: unknown;
  targetLang?: unknown;
  formality?: unknown;
}

interface TranslateTextRequest extends TranslateRequestBase {
  text: string;
}

interface TranslateImageRequest extends TranslateRequestBase {
  base64: string;
  mimeType: string;
}

interface AlternativesIpcRequest extends TranslateRequestBase {
  sentence: string;
  word: string;
  wordOffset: number;
  sourceText?: string;
}

function normalizeFormality(raw: unknown): Formality {
  return raw === "formal" || raw === "informal" ? raw : "default";
}

/**
 * Coerces an IPC payload into a translate call. The renderer is trusted but
 * the shapes still get normalized here — a stale renderer after an update
 * must not be able to send an unknown language code into a prompt.
 */
function normalizeTranslateRequest(payload: TranslateTextRequest | TranslateImageRequest): {
  text: string;
  targetLang: LangCode;
  options: { sourceLang: SourceLang; formality: Formality };
} {
  const settings = loadSettings();
  return {
    text: "text" in payload && typeof payload.text === "string" ? payload.text : "",
    targetLang: resolveLangCode(payload?.targetLang, settings.translatorTargetLang),
    options: {
      sourceLang: resolveSourceLang(payload?.sourceLang, settings.translatorSourceLang),
      formality: normalizeFormality(payload?.formality ?? settings.translatorFormality)
    }
  };
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
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
  clipboardMonitor?.stop();
  layoutSwitcher?.stop();
  dictationService?.stop();
  // The resident whisper model (#218) holds ~1.5 GB; it goes with the app.
  stopSharedWhisperServer();
  // The dispatcher reads Marshal's command stream; `general` may hold work and stays.
  assistantDispatcher?.stop();
  claudeHooks?.stop();
  dictationIndicator?.hide();
  meetingRecorder?.kill();
  meetingIndicator?.hide();
  meetingHistoryWindow?.close();
  captionsService?.stop();
  speechService?.stop();
  captureWindow?.close();
  recordingIndicator?.hide();
  videoRecorder?.kill();
  gifDialog?.close();
  tray?.destroy();
  tray = null;
  // Release every registered accelerator, including any new ones added later.
  // Safer than tracking each shortcut by name.
  globalShortcut.unregisterAll();
  // Force-stop the uiohook worker before V8 begins teardown. Belt-and-braces:
  // both consumers above already release via refcount, but if any handler
  // throws partway through, the native worker would otherwise outlive the
  // isolate and abort() the process via napi_fatal_error on shutdown.
  shutdownUiohookForQuit();
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

function initUpdater(): void {
  updateChecker = new UpdateChecker({ currentVersion: app.getVersion() });

  // Sweep staging dirs from earlier updates. The post-quit script frees its
  // own archive but cannot delete the directory it runs from, and a run that
  // dies earlier leaves the whole thing — three updates measured 407 MB (#172).
  // Deliberately after the swap, in the version that just landed: it cleans up
  // after its predecessor, including builds that predate this.
  void new UpdateInstaller()
    .sweepStale()
    .then((removed) => {
      if (removed > 0) console.log(`[marshal] swept ${removed} stale update staging dir(s)`);
    })
    .catch(() => undefined);

  // First check fires 60 s after boot so we don't compete with cold-start work
  // (backend fork, Swift helpers, translator init). Subsequent checks run on
  // a 6-hour interval; both honour the "automatic" pref so a user who
  // disabled background polling keeps the manual tray entry working.
  setTimeout(() => {
    if (loadSettings().checkForUpdatesAutomatic) {
      void runScheduledUpdateCheck();
    }
  }, UPDATE_CHECK_STARTUP_DELAY_MS);

  updateCheckTimer = setInterval(() => {
    if (loadSettings().checkForUpdatesAutomatic) {
      void runScheduledUpdateCheck();
    }
  }, UPDATE_CHECK_INTERVAL_MS);
}

/**
 * Background-triggered update check. Shows a non-blocking notification when a
 * new release lands and respects `lastDismissedVersion` so the user is not
 * pinged again for a version they already skipped.
 */
async function runScheduledUpdateCheck(): Promise<void> {
  if (!updateChecker) return;
  const result = await updateChecker.check();
  if (!("available" in result) || !result.available) return;
  if ("error" in result) return;

  const settings = loadSettings();
  if (settings.lastDismissedVersion === result.latestVersion) return;

  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title: t("update.available", { version: result.latestVersion }),
    body: result.releaseNotes
      ? result.releaseNotes.split("\n")[0].slice(0, 120)
      : t("update.openReleasePage"),
    silent: true
  });
  notif.on("click", () => {
    void shell.openExternal(result.releaseUrl);
  });
  notif.show();
}

/**
 * Manual "Check for updates…" trigger from the tray menu. Always shows a
 * dialog so the user gets feedback even when there's nothing new.
 */
async function runManualUpdateCheck(): Promise<void> {
  if (!updateChecker) {
    await dialog.showMessageBox({
      type: "info",
      title: "Marshal",
      message: t("update.notRunning")
    });
    return;
  }
  const result = await updateChecker.check();
  await showUpdateDialog(result);
}

/**
 * Renderer-facing variant: returns the raw outcome instead of opening a
 * blocking dialog. The Settings UI uses this to render the result inline
 * (with its own Download / Skip buttons) so the user stays in the popover.
 */
async function runSilentUpdateCheck(): Promise<UpdateCheckOutcome | { error: string }> {
  if (!updateChecker) {
    return { error: t("update.notRunning") };
  }
  return updateChecker.check();
}

/**
 * Drive the full in-app install: re-check (to pull fresh asset metadata),
 * plan the swap, download + verify + extract, then spawn the post-quit script
 * and quit. Progress events are forwarded to the calling renderer via the
 * `marshal:update-install-progress` channel.
 *
 * Throws on any failure so the renderer can surface the error inline.
 */
async function runUpdateInstall(sender: Electron.WebContents): Promise<{ ok: true; version: string }> {
  if (!updateChecker) {
    throw new Error(t("update.notRunning"));
  }
  const result = await updateChecker.check();
  if ("error" in result) {
    throw new Error(result.error);
  }
  if (!result.available) {
    throw new Error(t("update.alreadyLatest", { version: result.currentVersion }));
  }
  if (!result.installable) {
    throw new Error(t("update.notInstallable"));
  }

  const decision = planSwap({ execPath: process.execPath });
  if (!decision.ok) {
    throw new Error(decision.refusal.detail);
  }

  const installer = new UpdateInstaller();
  const forward = (p: InstallProgress) => {
    if (sender.isDestroyed()) return;
    sender.send("marshal:update-install-progress", p);
  };
  const dispose = installer.onProgress(forward);
  try {
    const prepared = await installer.prepare(result.installable, decision.plan);
    installer.commit(prepared);
    // Give the renderer a tick to render the "Relaunching…" state before we
    // tear down the window.
    setTimeout(() => {
      isQuitting = true;
      app.quit();
    }, 250);
    return { ok: true, version: result.installable.version };
  } finally {
    dispose();
  }
}

async function showUpdateDialog(result: UpdateCheckOutcome): Promise<void> {
  if ("error" in result) {
    await dialog.showMessageBox({
      type: "warning",
      title: t("update.checkFailed"),
      message: t("update.unreachable"),
      detail: result.error,
      buttons: [t("common.ok")]
    });
    return;
  }

  if (!result.available) {
    await dialog.showMessageBox({
      type: "info",
      title: "Marshal",
      message: t("update.upToDate", { version: result.currentVersion }),
      buttons: [t("common.ok")]
    });
    return;
  }

  const buttons = [t("update.download"), t("update.skipVersion"), t("update.later")];
  const { response } = await dialog.showMessageBox({
    type: "info",
    title: t("update.available", { version: result.latestVersion }),
    message: t("update.newVersion", { version: result.currentVersion }),
    detail: result.releaseNotes || t("update.openForNotes"),
    buttons,
    defaultId: 0,
    cancelId: 2
  });

  if (response === 0) {
    // Prefer the direct .dmg link if the release attached one; fall back to
    // the release HTML page so the user can pick the asset themselves.
    void shell.openExternal(result.downloadUrl ?? result.releaseUrl);
  } else if (response === 1) {
    saveSettings({ lastDismissedVersion: result.latestVersion });
  }
}

/**
 * Dump the macOS privacy gates dictation + capture depend on, so post-update
 * regressions like #82 (silent uiohook because Input Monitoring was reset by
 * the bundle swap) become diagnosable from the user's log. Runs unconditionally
 * on every boot — cost is one system call per gate, output is four lines.
 */
function logPermissionStatus(): void {
  if (process.platform !== "darwin") return;
  try {
    const mic = systemPreferences.getMediaAccessStatus("microphone");
    const screen = systemPreferences.getMediaAccessStatus("screen");
    // `false` means "don't show a prompt, just report the current state".
    const a11y = systemPreferences.isTrustedAccessibilityClient(false);
    console.log(`[marshal][perm] microphone=${mic}`);
    console.log(`[marshal][perm] screen=${screen}`);
    console.log(`[marshal][perm] accessibility=${a11y ? "granted" : "denied"}`);
    // Input Monitoring has no first-party Electron API. Surface uiohook's
    // observable behaviour instead — `[hotkey] start()` logs the next layer
    // down, so a missing "hotkey start" line in the log means uiohook didn't
    // attach (almost always = Input Monitoring not granted).
    console.log(`[marshal][perm] input-monitoring=(no API — watch for "[hotkey] start" below)`);

    // Do NOT call `systemPreferences.askForMediaAccess('microphone')` here.
    // On macOS Sequoia 15 with a self-signed bundle, the call returns
    // `denied` synchronously WITHOUT showing the UI prompt — and worse,
    // writes that denial into TCC.db, blocking the audio-recorder Swift
    // helper from ever raising its own prompt. Leave `not-determined` as
    // is so that AVCaptureDevice.requestAccess() inside audio-recorder.swift
    // gets to raise the actual UI prompt on first record. #82.
  } catch (err) {
    console.warn("[marshal][perm] failed to query permissions:", err);
  }
}

function initDictation(): void {
  console.log("[marshal] initDictation()");
  const enabled = (process.env.MARSHAL_DICTATION_ENABLED ?? "1") !== "0";
  if (!enabled) {
    console.log("[marshal] dictation: MARSHAL_DICTATION_ENABLED=0 — skipping");
    return;
  }

  try {
    dictationService = new DictationService(() => translatorGlossary?.list().map((entry) => entry.term) ?? []);
    console.log("[marshal] dictation: service constructed");
  } catch (err) {
    console.warn("[marshal] dictation disabled:", err instanceof Error ? err.message : err);
    return;
  }

  // Floating pill that surfaces recording state to the user even when their
  // focus is on a fullscreen / non-menu-bar app (the tray icon alone is not
  // discoverable enough — see #98).
  dictationIndicator ??= new DictationIndicator(preloadPath);

  dictationService.on("recording-start", () => {
    isDictating = true;
    setAssistantInputs({ dictating: true });
    speechService?.interrupt();
    dictationIndicator?.show();
    void refreshTrayState();
  });
  dictationService.on("recording-stop", () => {
    isDictating = false;
    setAssistantInputs({ dictating: false });
    dictationIndicator?.hide();
    void refreshTrayState();
  });
  dictationService.on("transcribe-start", () => setAssistantInputs({ transcribing: true }));
  dictationService.on("transcribe-end", () => setAssistantInputs({ transcribing: false }));
  dictationService.on("double-tap", () => {
    void toggleMeetingRecording("audio");
  });
  dictationService.on("assistant-command", handleVoiceCommand);
  dictationService.on("transcribed", ({ text }) => {
    if (!Notification.isSupported()) return;
    const preview = text.length > 80 ? `${text.slice(0, 77)}…` : text;
    new Notification({ title: t("notify.dictated"), body: preview, silent: true }).show();
  });
  dictationService.on("error", (err: Error) => {
    console.error("[dictation] error:", err);
    if (!Notification.isSupported()) return;
    new Notification({ title: t("notify.dictationError"), body: err.message, silent: true }).show();
  });
  // One-shot warning: shown only on the first silent session per app launch.
  // Persistent nagging on every restart would train users to dismiss it; one
  // clear surface per launch with a one-click path to System Settings is the
  // right balance. Issue #100.
  let silentNoticeShown = false;
  dictationService.on("input-monitoring-silent", () => {
    if (silentNoticeShown) return;
    silentNoticeShown = true;
    console.warn("[marshal] dictation: hotkey listener appears deaf; warning user");
    if (!Notification.isSupported()) return;
    const notif = new Notification({
      title: t("notify.pttDeaf"),
      body: t("notify.pttDeafBody"),
      silent: true
    });
    notif.on("click", () => {
      void shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
      );
    });
    notif.show();
  });

  console.log("[marshal] dictation: calling start()");
  void dictationService.start()
    .then(() => console.log("[marshal] dictation: start() resolved"))
    .catch((err) => console.error("[marshal] dictation: start() rejected:", err));

  // One-time boot check: if macOS system Dictation is enabled, its activation
  // shortcut (default: double-press Right Command) lives at a lower layer
  // than uiohook and can silently steal RightCmd from Marshal's push-to-talk.
  // We can't read the shortcut binding reliably (it's buried inside the
  // symbolic-hotkeys plist), so we trigger on the "enabled" flag alone and
  // leave the actual conflict diagnosis to the user. Issue #97.
  void detectMacOSDictationEnabled().then((status) => {
    if (!status.ok || !status.enabled) return;
    if (!Notification.isSupported()) return;
    console.warn("[marshal] dictation: macOS Dictation is enabled — may conflict with Marshal hotkey");
    const notif = new Notification({
      title: t("notify.macDictationOn"),
      body: t("notify.macDictationOnBody"),
      silent: true
    });
    notif.on("click", () => {
      void shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.keyboard?Dictation"
      );
    });
    notif.show();
  });
}

function stopDictationForReconfigure(): void {
  dictationService?.removeAllListeners();
  dictationService?.stop();
  dictationService = null;
  isDictating = false;
  dictationIndicator?.hide();
  void refreshTrayState();
}

function restartDictation(): void {
  if (process.env.MARSHAL_HEADLESS === "1") return;
  stopDictationForReconfigure();
  initDictation();
}

function initMeetingRecorder(): void {
  meetingRecorder = new MeetingRecorder({ userDataDir: app.getPath("userData") });
  meetingIndicator = new MeetingIndicator(preloadPath);
  const meetingsRoot = MeetingRecorder.meetingsDir(app.getPath("userData"));
  const recorder = meetingRecorder;
  meetingHistoryWindow = new MeetingHistoryWindow(
    preloadPath,
    new MeetingLibrary(meetingsRoot),
    meetingsRoot,
    () => recorder.activeId()
  );

  meetingRecorder.on("recording-start", () => {
    isMeetingRecording = true;
    meetingIndicator?.show();
    meetingHistoryWindow?.refresh();
    void refreshTrayState();
  });
  meetingRecorder.on("saved", ({ session }) => {
    // The recorder also stops itself when it can no longer capture; the pill
    // must not outlive the recording.
    isMeetingRecording = false;
    meetingIndicator?.hide();
    void refreshTrayState();
    meetingHistoryWindow?.refresh();
    if (!Notification.isSupported()) return;
    const notif = new Notification({
      title: t("notify.meetingSaved"),
      body: t(session.videoPath ? "notify.meetingSavedScreen" : "notify.meetingSavedAudio"),
      silent: true
    });
    notif.on("click", () => meetingHistoryWindow?.open());
    notif.show();
  });
  meetingRecorder.on("warning", (message: string) => {
    console.warn("[meeting] warning:", message);
    meetingHistoryWindow?.refresh();
    if (!Notification.isSupported()) return;
    new Notification({ title: t("notify.meetingProblem"), body: message, silent: true }).show();
  });
  meetingRecorder.on("error", (err: Error) => {
    console.error("[meeting] error:", err);
    isMeetingRecording = false;
    meetingIndicator?.hide();
    meetingHistoryWindow?.refresh();
    void refreshTrayState();
    if (!Notification.isSupported()) return;
    new Notification({ title: t("notify.meetingError"), body: err.message, silent: true }).show();
  });

  globalShortcut.unregister(MEETING_TOGGLE_ACCELERATOR);
  const registered = globalShortcut.register(MEETING_TOGGLE_ACCELERATOR, () => {
    void toggleMeetingRecording("audio");
  });
  if (registered) {
    console.log(`[marshal] meeting: toggle accelerator ${MEETING_TOGGLE_ACCELERATOR} registered`);
  } else {
    console.warn(`[marshal] meeting: toggle accelerator ${MEETING_TOGGLE_ACCELERATOR} could not register`);
  }
}

function initLiveCaptions(): void {
  if (!screenshotService) {
    console.warn("[captions] screenshot service missing — live captions disabled");
    return;
  }
  const pickRegion = async (): Promise<{ x: number; y: number; width: number; height: number } | null> => {
    const region = await screenshotService!.pickRegion();
    return region ? { x: region.x, y: region.y, width: region.width, height: region.height } : null;
  };
  const service = new LiveCaptionsService({
    preloadPath,
    userDataDir: app.getPath("userData"),
    pickRegion,
    // Read at call time, not captured: the translator is initialised
    // separately and may come up after captions do. Through the service the
    // Settings backend and the glossary apply to captions as they do to the
    // translator window (#210).
    translate: async (text, targetLang) => {
      if (!translatorService) throw new Error("Translator is not initialized.");
      const result = await translatorService.translateText(text, resolveLangCode(targetLang, "uk"), { sourceLang: "auto" });
      return result.translation;
    }
  });
  if (!service.isAvailable()) {
    console.warn("[captions] system-audio-tap helper missing — live captions disabled (run `npm run build`)");
    return;
  }
  captionsService = service;

  service.on("state-change", () => void refreshTrayState());
  service.on("error", (err: Error) => {
    console.error("[captions] error:", err);
    if (!Notification.isSupported()) return;
    new Notification({ title: t("notify.captionsFailed"), body: err.message, silent: true }).show();
  });

  handleIpc("marshal:captions-stop", () => {
    captionsService?.stop();
  });
  // Reference files for the summarizer (#188): Settings shows what is in
  // the folder and opens it in Finder; the folder is created on first open.
  handleIpc("marshal:captions-context-info", async () => {
    if (!captionsService) return { dir: "", files: [], truncated: 0 };
    const context = await captionsService.describeReferenceContext();
    return { dir: captionsService.referenceContextDir, files: context.files, truncated: context.truncated };
  });
  handleIpc("marshal:captions-context-open", async () => {
    if (!captionsService) return { ok: false, error: t("captions.unavailable") };
    const dir = captionsService.referenceContextDir;
    fs.mkdirSync(dir, { recursive: true });
    const failure = await shell.openPath(dir);
    return failure ? { ok: false, error: failure } : { ok: true };
  });

  registerCaptionsShortcuts();
}

function initSpeech(): void {
  speechService = new SpeechService(
    () => {
      const settings = loadSettings();
      return {
        enabled: settings.speechEnabled,
        engine: settings.speechEngine,
        holosVoice: settings.speechHolosVoice,
        rate: settings.speechRate,
        voiceUk: settings.speechVoiceUk,
        voiceEn: settings.speechVoiceEn
      };
    },
    // Our own recording or captions; a call in another app is caught by the mic probe (#359).
    () => (isDictating ? "dictation" : isMeetingRecording ? "meeting" : captionsService?.isRunning() ? "captions" : null),
    (speaking) => setAssistantInputs({ speaking }),
    isOnCall
  );
  handleIpc("marshal:speech-voices", () => speechService!.describeVoices());
  let piperInstall: Promise<{ ok: true } | { ok: false; error: string }> | null = null;
  handleIpc("marshal:speech-install-piper", () => {
    piperInstall ??= installPiper()
      .then(() => ({ ok: true as const }))
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        piperInstall = null;
      });
    return piperInstall;
  });
  let holosInstall: Promise<{ ok: true } | { ok: false; error: string }> | null = null;
  handleIpc("marshal:speech-install-holos", () => {
    holosInstall ??= installHolos()
      .then(() => ({ ok: true as const }))
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        holosInstall = null;
      });
    return holosInstall;
  });
  handleIpc("marshal:speech-clone-holos", async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: t("dialog.pickVoiceRecording"),
      properties: ["openFile"],
      filters: [{ name: t("dialog.audio"), extensions: ["wav", "mp3", "m4a", "flac", "ogg"] }]
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return { ok: false as const, canceled: true, error: "" };
    try {
      return { ok: true as const, name: await speechService!.cloneHolosVoice(result.filePaths[0]) };
    } catch (err) {
      return { ok: false as const, canceled: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  handleIpc("marshal:speech-test", async () => [
    await speechService!.speak("Маршал на зв'язку. Сесія завершила задачу.", { lang: "uk", force: true }),
    await speechService!.speak("Marshal is ready. The session finished its task.", { lang: "en", force: true })
  ]);
}

/**
 * (Re)binds the captions accelerators from the current settings. Called at
 * init and after every Settings save, so a hotkey change applies at once.
 */
function registerCaptionsShortcuts(): void {
  if (!captionsService) return;
  globalShortcut.unregister(captionsAccelerators.toggle);
  globalShortcut.unregister(captionsAccelerators.ocr);
  const settings = loadSettings();
  captionsAccelerators = { toggle: settings.captionsHotkey, ocr: settings.captionsOcrHotkey };

  const bindings: Array<{ accelerator: string; label: string; run: () => void }> = [
    { accelerator: captionsAccelerators.toggle, label: "Live captions toggle", run: () => void toggleLiveCaptions() },
    { accelerator: captionsAccelerators.ocr, label: "Live captions OCR context", run: () => void captionsService?.captureOcrContext() }
  ];
  for (const binding of bindings) {
    globalShortcut.unregister(binding.accelerator);
    let registered = false;
    try {
      registered = globalShortcut.register(binding.accelerator, binding.run);
    } catch (err) {
      // A malformed accelerator string throws instead of returning false.
      console.warn(`[marshal] captions: ${binding.label} accelerator "${binding.accelerator}" is invalid:`, err instanceof Error ? err.message : err);
    }
    if (registered) {
      console.log(`[marshal] captions: ${binding.label} accelerator ${binding.accelerator} registered`);
    } else {
      // Same failure mode as the capture hotkeys (#135): say so instead of
      // letting a dead key look like a broken feature.
      console.warn(`[marshal] captions: ${binding.label} accelerator ${binding.accelerator} could not register — another app owns it`);
    }
  }
  scheduleTrayRefresh();
}

async function toggleLiveCaptions(): Promise<void> {
  if (!captionsService) return;
  try {
    await captionsService.toggle();
  } catch {
    // Reported through the service's "error" event as a notification.
  }
}

function initCalendar(): void {
  calendarService = createCalendarService({
    dataDir: app.getPath("userData"),
    joinAndRecord: () => void startMeetingRecording("audio")
  });
  calendarService.on("reminder", (reminder) => {
    const { title, body } = reminderText(reminder, uiLanguage(), new Date());
    announceToAssistant(`${title} — ${body}`);
  });
  syncCalendar();
}

// Off = no fetch and no timer at all (#281).
function syncCalendar(): void {
  if (loadSettings().calendarEnabled) calendarService?.start();
  else calendarService?.stop();
}

function calendarStatus() {
  const next = calendarService?.nextMeeting() ?? null;
  return {
    ...(calendarService?.status() ?? { configured: false, running: false, lastSyncAt: null, lastError: null }),
    next: next ? { title: next.title, start: next.start.toISOString() } : null
  };
}

async function toggleMeetingRecording(mode: MeetingMode): Promise<void> {
  if (!meetingRecorder) return;
  if (isMeetingRecording) {
    await stopMeetingRecording();
  } else if (!meetingRecorder.isRecording()) {
    // isRecording() without isMeetingRecording = the previous call is still
    // being saved; starting now would be refused anyway.
    await startMeetingRecording(mode);
  }
}

async function startMeetingRecording(mode: MeetingMode): Promise<void> {
  if (!meetingRecorder || isMeetingRecording) return;
  try {
    await meetingRecorder.start(mode);
  } catch (err) {
    isMeetingRecording = false;
    meetingIndicator?.hide();
    void refreshTrayState();
    if (Notification.isSupported()) {
      new Notification({
        title: t("notify.meetingFailed"),
        body: err instanceof Error ? err.message : String(err),
        silent: true
      }).show();
    }
  }
}

async function stopMeetingRecording(): Promise<void> {
  if (!meetingRecorder || !isMeetingRecording) return;
  // The call is over for the user the moment they press Stop; saving the
  // files afterwards takes seconds and should not keep the pill on screen.
  isMeetingRecording = false;
  meetingIndicator?.hide();
  void refreshTrayState();
  await meetingRecorder.stop();
  meetingHistoryWindow?.refresh();
}

function initCapture(): void {
  captureService = new CaptureService(preloadPath);
  captureWindow = new CaptureWindow(preloadPath);
  captureWindow.setAlwaysOnTop(loadSettings().captureEditorAlwaysOnTop);
  // The archive lives in userData, not the user's capture folder: it is
  // pruned on a budget, and Marshal must never delete a file the user saved
  // on purpose. See capture/capture-archive.ts.
  captureArchive = new CaptureArchive(path.join(app.getPath("userData"), "capture-history"));
  captureHistoryWindow = new CaptureHistoryWindow(
    preloadPath,
    () => loadSettings().captureDefaultFolder,
    captureArchive
  );
  floatingToolbar = new FloatingToolbar(preloadPath);
  recordingIndicator = new RecordingIndicator(preloadPath);
  gifDialog = new GifDialog(preloadPath);

  if (VideoRecorder.isAvailable()) {
    videoRecorder = new VideoRecorder();
    videoRecorder.on("error", (err: Error) => {
      console.error("[marshal] video recorder error:", err);
      if (Notification.isSupported()) {
        new Notification({
          title: t("notify.recordingError"),
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
  // `globalShortcut.register` returns false when another app already owns the
  // combination. Swallowing that produced the worst possible symptom: the key
  // does nothing and nothing explains why. Log every failure and tell the user
  // once, so a clash reads as a clash and not as a broken feature (#135).
  const captureAccelerators: Array<{ accelerator: string; label: string; run: () => void }> = [
    { accelerator: "CommandOrControl+Alt+3", label: t("tray.captureArea"), run: () => void runCapture("area") },
    { accelerator: "CommandOrControl+Alt+4", label: t("tray.captureFullscreen"), run: () => void runCapture("fullscreen") },
    { accelerator: "CommandOrControl+Alt+6", label: t("tray.recordFullscreen"), run: () => void toggleVideoRecording("fullscreen") }
  ];

  const unavailable: string[] = [];
  for (const { accelerator, label, run } of captureAccelerators) {
    const registered = globalShortcut.register(accelerator, run);
    if (registered) {
      console.log(`[marshal] capture: ${accelerator} registered (${label})`);
    } else {
      console.warn(`[marshal] capture: ${accelerator} could not register — already in use? (${label})`);
      unavailable.push(`${accelerator} — ${label}`);
    }
  }

  if (unavailable.length > 0 && Notification.isSupported()) {
    new Notification({
      title: t("notify.shortcutsUnavailable"),
      body: t("notify.shortcutsUnavailableBody", { list: unavailable.join("\n") }),
      silent: true
    }).show();
  }
}

async function toggleVideoRecording(kind: "fullscreen" | "area"): Promise<void> {
  if (!videoRecorder) {
    if (Notification.isSupported()) {
      new Notification({
        title: t("notify.recordingUnavailable"),
        body: t("notify.recordingUnavailableBody"),
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

  let area: { x: number; y: number; width: number; height: number } | null = null;

  try {
    if (kind === "area") {
      const pick = await pickArea({ preloadPath });
      if (!pick) return;
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
        title: t("notify.recordingFailed"),
        body: err instanceof Error ? err.message : String(err),
        silent: true
      }).show();
    }
  }
}

async function stopVideoRecording(): Promise<void> {
  if (!videoRecorder || !isRecording) return;
  try {
    const outPath = await videoRecorder.stop();
    lastRecordingPath = outPath;
    cleanupRecording();
    if (Notification.isSupported()) {
      const name = outPath.split("/").pop() ?? outPath;
      const body = GifEncoder.isAvailable()
        ? t("notify.recordingSavedGif", { name })
        : name;
      const notif = new Notification({
        title: t("notify.recordingSaved"),
        body,
        silent: true
      });
      notif.on("click", () => {
        if (GifEncoder.isAvailable() && gifDialog) {
          gifDialog.open({ inputPath: outPath });
        } else {
          void shell.showItemInFolder(outPath);
        }
      });
      notif.show();
    }
  } catch (err) {
    cleanupRecording();
    if (Notification.isSupported()) {
      new Notification({
        title: t("notify.recordingFailed"),
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

function buildCaptureSubmenu(): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: t("tray.captureArea"),
      accelerator: "CommandOrControl+Alt+3",
      click: () => void runCapture("area")
    },
    {
      label: t("tray.captureFullscreen"),
      accelerator: "CommandOrControl+Alt+4",
      click: () => void runCapture("fullscreen")
    },
    { type: "separator" }
  ];

  if (isRecording) {
    items.push({ label: t("tray.stopRecording"), click: () => void stopVideoRecording() });
  } else {
    items.push({
      label: t("tray.recordFullscreen"),
      accelerator: "CommandOrControl+Alt+6",
      enabled: videoRecorder !== null,
      click: () => void toggleVideoRecording("fullscreen")
    });
    if (videoRecorder) {
      items.push({
        label: t("tray.recordArea"),
        click: () => void toggleVideoRecording("area")
      });
    }
  }

  items.push(
    { type: "separator" },
    {
      label: t("tray.convertGif"),
      enabled: GifEncoder.isAvailable(),
      click: () => void openGifConverter()
    },
    { type: "separator" },
    {
      label: t("tray.captureHistory"),
      click: () => captureHistoryWindow?.open()
    },
    {
      label: t(floatingToolbar?.isOpen() ? "tray.hideToolbar" : "tray.showToolbar"),
      click: () => floatingToolbar?.toggle()
    },
    { type: "separator" },
    {
      label: t("tray.scrollingCapture"),
      click: () => void runScrollingCapture()
    }
  );

  return items;
}

/**
 * Tray entry for the whisper model. While a download runs it turns into a
 * progress/cancel row, because a 1.5 GB fetch is the one operation here the
 * user may well want to stop.
 */
/**
 * The two reasons a backend gets dropped need different advice: a refused key
 * is fixed in .env, a missing model is fixed by naming one the account
 * actually serves. Saying "check your key" for a 404 sends the user hunting
 * in the wrong place (#162).
 */
function fallbackNoticeText(notice: TranslatorFallbackNotice): string {
  const to = `Translating through ${backendLabel(notice.to)} instead, which is slower.`;
  if (notice.reason === "model") {
    return (
      `${backendLabel(notice.from)} has no model "${notice.model ?? "?"}" (HTTP ${notice.status}). ` +
      `${to} Set MARSHAL_TRANSLATOR_MODEL to a model your account serves and restart Marshal.`
    );
  }
  return (
    `${backendLabel(notice.from)} rejected the API key (HTTP ${notice.status}). ` +
    `${to} Fix MARSHAL_API_KEY and restart Marshal, or pin a backend in Settings.`
  );
}

/** Human-readable backend names for user-facing notices. */
function backendLabel(id: string): string {
  switch (id) {
    case "claude-cli":
      return "Claude CLI";
    case "codex-cli":
      return "Codex CLI";
    case "claude-api":
      return "Anthropic API";
    case "openai-api":
    case "groq":
      return "the OpenAI-compatible API";
    case "apple-vision":
      return "Apple Vision + API";
    default:
      return id;
  }
}

function buildModelMenuItem(): Electron.MenuItemConstructorOptions {
  if (modelDownload) {
    return {
      label: t("tray.cancelModelDownload", { percent: modelDownload.percent }),
      click: () => modelDownload?.abort.abort()
    };
  }
  const installed = findInstalledModel();
  if (installed) {
    const name = installed.name.replace(/^ggml-|\.bin$/gu, "");
    const preferred = findModelSpec(DEFAULT_MODEL_NAME);
    // An older default stays in use until the owner fetches the lighter one; nothing is deleted.
    if (preferred && installed.name !== DEFAULT_MODEL_NAME && installed.name === "ggml-large-v3-turbo.bin") {
      return {
        label: t("tray.lighterModel", { name, label: preferred.label, size: formatBytes(preferred.bytes) }),
        click: () => void runModelDownload()
      };
    }
    return { label: t("tray.dictationModel", { name }), enabled: false };
  }
  return {
    label: t("tray.downloadModel"),
    click: () => void runModelDownload()
  };
}

/**
 * Downloads the default whisper model into the shared models directory.
 * Confirms first — this is a multi-gigabyte fetch — then reports progress
 * through the tray tooltip and finishes with a dialog either way.
 */
async function runModelDownload(name: string = DEFAULT_MODEL_NAME): Promise<void> {
  if (modelDownload) return;

  const spec = findModelSpec(name);
  if (!spec) {
    await dialog.showMessageBox({
      type: "error",
      title: t("model.unknown"),
      message: t("model.unknownBody", { name })
    });
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: "question",
    title: t("model.downloadTitle"),
    message: t("model.downloadQuestion", { label: spec.label, size: formatBytes(spec.bytes) }),
    detail: t("model.downloadDetail", { dir: modelsDir() }),
    buttons: [t("model.download"), t("common.cancel")],
    defaultId: 0,
    cancelId: 1
  });
  if (response !== 0) return;

  const abort = new AbortController();
  modelDownload = { name, percent: 0, abort };
  void refreshTrayState();

  try {
    await downloadModel(name, {
      signal: abort.signal,
      onProgress: ({ ratio }) => {
        if (!modelDownload) return;
        const percent = ratio === null ? 0 : Math.min(100, Math.round(ratio * 100));
        // Only repaint the tray on a whole-percent change — the progress
        // callback fires per chunk, which is thousands of times per GB.
        if (percent === modelDownload.percent) return;
        modelDownload.percent = percent;
        void refreshTrayState();
      }
    });
    modelDownload = null;
    // Pick the new model up without making the user restart the app.
    restartDictation();
    await dialog.showMessageBox({
      type: "info",
      title: t("model.ready"),
      message: t("model.installed", { label: spec.label }),
      detail: t("model.savedTo", { dir: modelsDir() })
    });
  } catch (err) {
    const aborted = abort.signal.aborted;
    modelDownload = null;
    if (!aborted) {
      await dialog.showMessageBox({
        type: "error",
        title: t("model.failed"),
        message: err instanceof Error ? err.message : String(err),
        detail: t("model.partialKept")
      });
    }
  } finally {
    modelDownload = null;
    void refreshTrayState();
  }
}

// Read when the menu opens, never in the background (#281).
function buildClaudeSessionsSubmenu(): Electron.MenuItemConstructorOptions[] {
  const sessions = listLiveSessions();
  if (sessions.length === 0) return [{ label: t("tray.noSessions"), enabled: false }];
  return sessions.map((session) => ({
    label: `${session.name} · ${path.basename(session.cwd)} · ${describeStatus(session, uiLanguage())}`,
    click: () => {
      void focusSession(session.pid).catch((err: unknown) => {
        console.warn("[claude-sessions] focus failed:", err instanceof Error ? err.message : err);
      });
    }
  }));
}

function buildTrayMenu(): Electron.Menu {
  const settings = loadSettings();
  const dictationAvailable = dictationService !== null;
  const recording = dictationService?.isCurrentlyRecording() ?? false;
  const meetingAvailable = meetingRecorder !== null;
  const captionsRunning = captionsService?.isRunning() ?? false;
  const nextMeetingItem = calendarTrayItem(calendarService?.nextMeeting() ?? null);

  return Menu.buildFromTemplate([
    ...(nextMeetingItem ? [nextMeetingItem, { type: "separator" as const }] : []),
    { label: t("tray.openMarshal"), click: () => openAssistantHome() },
    { label: t(assistantInputs.asleep ? "tray.wakeAssistant" : "tray.sleepAssistant"), click: () => setAssistantAsleep(!assistantInputs.asleep) },
    { label: t("tray.openTranslator"), click: () => openTranslator() },
    { type: "separator" },
    // Dictation toggle — the path to start/stop recording when the hotkey
    // listener is dead (#84). No global accelerator: Cmd+Alt+M sat next to the
    // meeting toggle and started dictation instead of a recording (#240).
    {
      label: t(recording ? "tray.stopDictation" : "tray.startDictation"),
      enabled: dictationAvailable,
      click: () => dictationService?.toggleRecording()
    },
    ...(isMeetingRecording
      ? [{
          label: t("tray.stopMeeting"),
          accelerator: MEETING_TOGGLE_ACCELERATOR,
          click: () => void stopMeetingRecording()
        }]
      : [
          {
            label: t("tray.recordMeetingAudio"),
            accelerator: MEETING_TOGGLE_ACCELERATOR,
            enabled: meetingAvailable,
            click: () => void startMeetingRecording("audio")
          },
          {
            label: t("tray.recordMeetingScreen"),
            enabled: meetingAvailable,
            click: () => void startMeetingRecording("screen")
          }
        ]),
    {
      label: t("tray.meetingRecordings"),
      enabled: meetingAvailable,
      click: () => meetingHistoryWindow?.open()
    },
    {
      label: t(captionsRunning ? "tray.stopCaptions" : "tray.startCaptions"),
      accelerator: captionsAccelerators.toggle,
      enabled: captionsService !== null,
      click: () => void toggleLiveCaptions()
    },
    {
      label: t("tray.liveCaptions"),
      visible: captionsService !== null,
      submenu: [
        {
          label: t("tray.moveOverlay"),
          type: "checkbox",
          checked: captionsService?.isMoveMode() ?? false,
          enabled: captionsRunning,
          click: () => {
            captionsService?.toggleMoveMode();
            scheduleTrayRefresh();
          }
        },
        {
          label: t("tray.readRegion"),
          accelerator: captionsAccelerators.ocr,
          enabled: captionsRunning,
          click: () => void captionsService?.captureOcrContext()
        },
        { label: t("tray.resetOcrRegion"), click: () => captionsService?.resetOcrRegion() },
        { label: t("tray.resetOverlay"), click: () => captionsService?.resetOverlayPosition() }
      ]
    },
    { label: t("tray.capture"), submenu: buildCaptureSubmenu() },
    { label: t("tray.claudeSessions"), submenu: buildClaudeSessionsSubmenu() },
    buildModelMenuItem(),
    // Last resort when the editor is open with floating turned off: an agent
    // app has no Dock icon to click (#168).
    {
      label: t("tray.raiseEditor"),
      enabled: captureWindow?.isOpen() ?? false,
      click: () => captureWindow?.raise()
    },
    { type: "separator" },
    {
      label: t("tray.startAtLogin"),
      type: "checkbox",
      checked: settings.launchAtLogin,
      click: (item) => {
        const next = saveSettings({ launchAtLogin: item.checked });
        applyLaunchAtLogin(next);
      }
    },
    {
      label: t("tray.checkUpdates"),
      click: () => void runManualUpdateCheck()
    },
    { type: "separator" },
    {
      label: t("tray.quit"),
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

/**
 * Mirror the persisted `launchAtLogin` preference into macOS Login Items.
 * Uses Electron's wrapper around `LSSharedFileListItem`, which is what System
 * Settings → General → Login Items reads — no launchd plist to maintain.
 *
 * On non-darwin platforms this is a no-op; Electron documents the call as
 * supported only on macOS/Windows and we deliberately scope packaging to
 * macOS today.
 */
function applyLaunchAtLogin(settings: MarshalSettings): MarshalSettings {
  if (process.platform !== "darwin" && process.platform !== "win32") return settings;

  const requested = settings.launchAtLogin;
  try {
    app.setLoginItemSettings({
      openAtLogin: requested,
      // openAsHidden hides the dock-less accessory app on launch — we already
      // suppress the dock via setActivationPolicy("accessory"), but this also
      // suppresses any brief renderer flash.
      openAsHidden: true
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[marshal] launch-at-login update failed:", message);
    return saveSettings({
      launchAtLogin: false,
      launchAtLoginLastError: message
    });
  }

  const actual = app.getLoginItemSettings().openAtLogin;
  if (requested && !actual) {
    const message = "macOS rejected the Login Item update. Check System Settings -> General -> Login Items.";
    console.warn("[marshal] launch-at-login update rejected:", message);
    return saveSettings({
      launchAtLogin: false,
      launchAtLoginLastError: message
    });
  }

  if (settings.launchAtLoginLastError) {
    return saveSettings({ launchAtLoginLastError: "" });
  }
  return settings;
}

async function getSetupHealth(): Promise<SetupHealthSummary> {
  const settings = loadSettings();
  const whisper = resolveWhisperAssetPaths();
  const isDarwin = process.platform === "darwin";
  return buildSetupHealth({
    language: uiLanguage(),
    platform: process.platform,
    appVersion: app.getVersion(),
    buildInfo: readBuildInfo(),
    dictationEnabled: settings.dictationEnabled,
    dictationBackend: settings.dictationBackend,
    microphoneStatus: isDarwin ? systemPreferences.getMediaAccessStatus("microphone") : undefined,
    screenStatus: isDarwin ? systemPreferences.getMediaAccessStatus("screen") : undefined,
    accessibilityTrusted: isDarwin ? systemPreferences.isTrustedAccessibilityClient(false) : undefined,
    apiKeyPresent: Boolean(process.env.MARSHAL_API_KEY?.trim()),
    envFilePath: path.join(app.getPath("userData"), ".env"),
    whisperBinPath: whisper.bin,
    whisperModelPath: whisper.model,
    codesignIdentityPresent: isDarwin ? await hasMarshalCodesignIdentity() : undefined,
    launchAtLogin: settings.launchAtLogin,
    launchAtLoginOpenAtLogin: process.platform === "darwin" || process.platform === "win32"
      ? app.getLoginItemSettings().openAtLogin
      : undefined,
    launchAtLoginLastError: settings.launchAtLoginLastError,
    memory: isDarwin ? await measureFootprint(process.pid).catch(() => null) : undefined
  });
}

function readBuildInfo(): BuildInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(desktopDistDir, "build-info.json"), "utf8")) as BuildInfo;
  } catch {
    return null;
  }
}

async function hasMarshalCodesignIdentity(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning"
    ], { timeout: 2_000 });
    return stdout.includes("Marshal Self-Signed");
  } catch {
    return false;
  }
}

function initTranslator(): void {
  const settings = loadSettings();
  // If the service cannot be built the translator is unavailable, but the
  // clipboard monitor, layout switcher, screenshot service (which live
  // captions also need) and the hotkeys still come up (#156).
  try {
    translatorService = new TranslatorService({
      choice: settings.translatorBackend,
      bridgeMode: settings.bridgeMode,
      sourceLang: settings.translatorSourceLang,
      targetLang: settings.translatorTargetLang,
      formality: settings.translatorFormality
    });
  } catch (err) {
    translatorService = null;
    const message = err instanceof Error ? err.message : String(err);
    console.error("[marshal] translator unavailable:", message);
    if (Notification.isSupported()) {
      new Notification({
        title: t("notify.translatorUnavailable"),
        body: t("notify.translatorUnavailableBody", { reason: message.split("\n")[0] }),
        silent: true
      }).show();
    }
  }
  translatorWindow = new TranslatorWindow(preloadPath, app.getPath("userData"));
  screenshotService = new ScreenshotService(preloadPath);
  // First exec of a freshly installed helper is slow enough to time out the
  // first OCR (#181); pay that cost now, in the background.
  void warmUpAppleVisionOcr();
  warmUpMicUsers();
  translatorHistory = new TranslatorHistoryStore(app.getPath("userData"));
  translatorGlossary = new TranslatorGlossaryStore(app.getPath("userData"));
  translatorService?.setGlossary(translatorGlossary.list());

  // A rejected API key makes `auto` swap to a keyless backend mid-session.
  // Say so once: the user's own symptom is otherwise just "why is this slow
  // now" (#160).
  translatorService?.on("fallback", (notice: TranslatorFallbackNotice) => {
    console.warn(
      `[marshal] translator: ${notice.from} unusable (${notice.reason}, HTTP ${notice.status}); using ${notice.to}`
    );
    translatorWindow?.showNotice(fallbackNoticeText(notice));
  });

  clipboardMonitor = new ClipboardMonitor();

  // ⌘⌥T. What it should do depends on the window, which the monitor cannot
  // see — so the decision lives here. See decideHotkeyAction (#166).
  clipboardMonitor.on("hotkey", (clipboardText: string) => {
    if (!translatorWindow) return;
    const action = decideHotkeyAction({
      visible: translatorWindow.isVisible(),
      focused: translatorWindow.isFocused(),
      hasContent: translatorWindow.hasUnfinishedContent(),
      clipboardText: typeof clipboardText === "string" ? clipboardText : ""
    });

    if (action === "hide") {
      translatorWindow.hide();
      return;
    }
    if (action === "show") {
      openTranslator();
      return;
    }
    clipboardMonitor?.emitTranslate(clipboardText.trim());
  });
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
          title: t("permission.screenTitle"),
          message: t("permission.screenMessage"),
          detail: t("permission.screenDetail"),
          buttons: [t("permission.openSettings"), t("update.later")],
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

      // The process starts while the user drags the region.
      translatorService.warmUp();
      translatorWindow.hide();
      // Brief pause to let the window actually disappear before capturing
      await new Promise<void>((r) => setTimeout(r, 120));

      try {
        const base64 = await screenshotService.captureWithCrop();
        if (!base64) return; // user cancelled

        translatorWindow.showLoading("image");
        const { targetLang } = translatorService.languagePair;
        const image = prepareTranslatorImage(base64, "image/png");
        const result = await translatorService.translateImage(image.base64, image.mimeType, targetLang);
        translatorWindow.showImageResult(result);
        pushHistory({
          text: "",
          translation: result.translation,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          mode: "image",
          timestamp: Date.now()
        });
      } catch (err) {
        // showError opens the popup when nothing is on screen.
        translatorWindow.showError(err instanceof Error ? err.message : String(err));
      }
    })();
  });
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("Marshal");
  tray.on("click", () => toggleAssistantHome());
  tray.on("right-click", () => {
    tray?.popUpContextMenu(buildTrayMenu());
  });

  void refreshTrayState();
}

function openAssistantHome(): void {
  assistantHome ??= new AssistantHomeWindow(preloadPath, (open) => {
    watchAssistantSessions(sessionsShown());
    if (open) void measureAssistantMemory();
  });
  setAssistantInputs({ offline: dictationService === null });
  assistantHome.open();
  pushAssistantStrip();
}

function assistantStrip(): AssistantStrip {
  const settings = loadSettings();
  const meeting = calendarService?.nextMeeting() ?? null;
  return {
    active: {
      dictation: isDictating,
      captions: captionsService?.isRunning() ?? false,
      translator: translatorWindow?.isVisible() ?? false,
      recording: isMeetingRecording || isRecording
    },
    speech: settings.speechEnabled,
    memory: assistantMemory,
    meeting: meeting ? { title: meeting.title, start: meeting.start.toISOString(), joinable: meeting.link !== null } : null,
    hotkey: assistantHotkey
  };
}

function pushAssistantStrip(): void {
  if (!assistantHome?.isOpen()) return;
  assistantHome.update({ lang: uiLanguage(), strip: assistantStrip() });
}

async function measureAssistantMemory(): Promise<void> {
  if (process.platform !== "darwin") return;
  const summary = await measureFootprint(process.pid).catch(() => null);
  assistantMemory = summary
    ? { usedMb: Math.round(summary.appBytes / 1024 ** 2), budgetMb: Math.round(IDLE_BUDGET_BYTES / 1024 ** 2) }
    : null;
  pushAssistantStrip();
}

function countWaitingSessions(): void {
  const count = loadSettings().assistantWaitingBadge
    ? listLiveSessions().filter((session) => session.status === "waiting").length
    : 0;
  if (count === waitingSessionCount) return;
  waitingSessionCount = count;
  void refreshTrayState();
}

function registerAssistantHotkey(): void {
  const accelerator = assistantHotkeyFromEnv(process.env.MARSHAL_ASSISTANT_HOTKEY);
  if (!accelerator) return;
  const taken = [
    MEETING_TOGGLE_ACCELERATOR,
    captionsAccelerators.toggle,
    captionsAccelerators.ocr,
    "CommandOrControl+Alt+3",
    "CommandOrControl+Alt+4",
    "CommandOrControl+Alt+6",
    "CommandOrControl+Shift+2",
    TRANSLATOR_HOTKEY,
    process.env.MARSHAL_LAYOUT_SWITCH_HOTKEY ?? DEFAULT_LAYOUT_SWITCH_HOTKEY
  ];
  const conflict = findAcceleratorConflict(accelerator, taken);
  if (conflict) {
    console.warn(`[assistant] hotkey ${accelerator} collides with Marshal's own ${conflict}; not registered`);
    return;
  }
  let registered = false;
  try {
    registered = globalShortcut.register(accelerator, toggleAssistantHome);
  } catch (err) {
    console.warn(`[assistant] hotkey "${accelerator}" is invalid:`, err instanceof Error ? err.message : err);
    return;
  }
  if (registered) assistantHotkey = accelerator;
  console.log(`[assistant] hotkey ${accelerator} ${registered ? "registered" : "could not register — another app owns it"}`);
}

// A window behind another app is raised, not closed (#336).
function toggleAssistantHome(): void {
  if (assistantHome?.isInFront()) assistantHome.close();
  else openAssistantHome();
}

function setAssistantInputs(next: Partial<AssistantInputs>): void {
  assistantInputs = { ...assistantInputs, ...next };
  assistantHome?.update({ state: deriveAssistantState(assistantInputs) });
  updateAmbient();
}

// ── Ambient indicators (#285) ──
function initAmbient(): void {
  glowFrame = new GlowFrame(preloadPath);
  miniWidget = new MiniWidget(
    preloadPath,
    {
      load: () => loadSettings().assistantWidgetPosition,
      save: (point) => saveSettings({ assistantWidgetPosition: point })
    },
    () => watchAssistantSessions(sessionsShown())
  );
  if (loadSettings().assistantWidget) miniWidget.open();
  updateAmbient();
}

function updateAmbient(): void {
  const state = deriveAssistantState(assistantInputs);
  const inCall = isMeetingRecording || (captionsService?.isRunning() ?? false);
  glowFrame?.set(glowFor(state, inCall, loadSettings().assistantGlow));
  miniWidget?.update({ state, lang: uiLanguage() });
}

/** The sessions watcher runs only while a window that lists sessions is open (#281). */
function sessionsShown(): boolean {
  return (assistantHome?.isOpen() ?? false) || (miniWidget?.isOpen() ?? false);
}

/** What Marshal notifies or says also lands in the home window's line (#308). */
function announceToAssistant(text: string): void {
  assistantLines = pushLine(assistantLines, text);
  assistantHome?.update({ lines: assistantLines });
}

// Voice assistant (#318): the home mic talks to the dispatcher session, which
// routes the command and calls back through `./marshal say | do | spawn`.
function initAssistantDispatcher(): void {
  if (!claudeHooks) return;
  const hooks = claudeHooks;
  const ownSessions = () => listLiveSessions().filter((session) => !assistantDispatcher?.isDispatcher(session));
  assistantDispatcher = new AssistantDispatcher({
    userDataDir: app.getPath("userData"),
    hookDir: () => hooks.hookDir,
    settings: () => {
      const settings = loadSettings();
      return {
        model: settings.assistantDispatcherModel,
        // Same "~/" expansion as the routing roots.
        generalDir: parseRoutingRoots(settings.assistantGeneralDir)[0] ?? "",
        generalMode: settings.assistantGeneralPermissionMode,
        routingRoots: parseRoutingRoots(settings.claudeCodeRoutingRoots)
      };
    },
    liveSessions: () => listLiveSessions(),
    context: () => hooks.routingContext(ownSessions()),
    say: sayAsAssistant,
    ask: askOwner,
    runAction: assistantVoiceAction,
    announce: announceToAssistant,
    focus: (pid) => {
      void focusSession(pid).catch(() => undefined);
    },
    insert: async (text) => (dictationService ? dictationService.insert(text) : "not running"),
    reply: (session, text) =>
      replyToSession(session, text, {
        hostApp: hostAppOf,
        focusSession,
        // The app-level fallback waits up to 500 ms for an Electron tree to appear.
        probe: () => probeFocusedElement({ appLevel: true, timeoutMs: 1_000 }),
        writeClipboard: (value) => clipboard.writeText(value),
        sendKey: (key) => sendKeystroke(key),
        activate: async (app) => {
          await execFileAsync("open", ["-a", app]);
        }
      }),
    runAppleScript: async (script) => {
      await execFileAsync("osascript", ["-e", script], { env: launchEnv });
    },
    processList: listProcesses,
    log: (message) => console.log(message)
  });
  hooks.setAssistantRoutes(assistantDispatcher);
  void syncAssistantDispatcher();
}

async function syncAssistantDispatcher(): Promise<void> {
  if (!assistantDispatcher || !claudeHooks) return;
  if (!loadSettings().assistantDispatcher) {
    assistantDispatcher.stop();
    return;
  }
  // Without the receiver the helper has nobody to talk to, and without the
  // Stop hook the owner never hears what a session did.
  const hooks = await claudeHooks.ensureInstalled();
  if (hooks.error) {
    sayAsAssistant(`Асистент не запустився: ${hooks.error}`);
    return;
  }
  await assistantDispatcher.start();
}

// Dock button (#340): start the dispatcher if it is not running and show its
// Terminal window. Pressing it is the same explicit choice as the first mic press.
async function showDispatcherTerminal(): Promise<void> {
  if (!assistantDispatcher || !claudeHooks) return;
  if (!loadSettings().assistantDispatcher) {
    saveSettings({ assistantDispatcher: true });
    pushAssistantStrip();
  }
  const hooks = await claudeHooks.ensureInstalled();
  if (hooks.error) {
    announceToAssistant(`${t("home.dispatcherFailed")}: ${hooks.error}`);
    return;
  }
  try {
    await assistantDispatcher.reveal();
  } catch (err) {
    announceToAssistant(`${t("home.dispatcherFailed")}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // `general` too, minimised as usual; the dispatcher just opened is not opened twice.
  await assistantDispatcher.start();
}

// The first command — home mic or the held talk key (#361) — turns the
// assistant on: that is the owner's explicit choice, and a voice assistant
// that cannot speak is useless. A command sent meanwhile waits in the queue.
function enableAssistantOnce(): void {
  if (loadSettings().assistantDispatcher) return;
  saveSettings({ assistantDispatcher: true, speechEnabled: true });
  pushAssistantStrip();
  announceToAssistant("Асистент увімкнено: hooks Claude Code встановлено, диспетчер і general стартують у Terminal.");
  void syncAssistantDispatcher();
}

function openMicState(): OpenMicState {
  return { asleep: assistantInputs.asleep, meeting: isMeetingRecording, captions: captionsService?.isRunning() ?? false, onCall: isOnCall };
}

// One click (#384): a pause ends the command, nobody speaking drops it, a
// second click still stops at once. Where the open mic is not allowed the
// click stays a plain toggle, so "Маршал, прокинься" still works asleep.
async function talkToAssistant(): Promise<void> {
  if (!dictationService) return;
  if (dictationService.isCurrentlyRecording()) {
    dictationService.stopRecording();
    return;
  }
  enableAssistantOnce();
  const endOnPause = await openMicAllowed(openMicState());
  dictationService.startRecording("assistant", { endOnPause });
}

// Once per launch, at most once per 30 min (#360); silent on a call, and then the next launch greets.
async function greetOnLaunch(): Promise<void> {
  if (!speechService || !loadSettings().speechEnabled || assistantInputs.asleep) return;
  const file = path.join(app.getPath("userData"), "greeted.json");
  if (!shouldGreet(Date.now(), readLastGreeted(file))) return;
  const now = new Date();
  const facts = {
    lang: uiLanguage(),
    now,
    meeting: meetingToday(calendarService?.nextMeeting() ?? null, now),
    waiting: listLiveSessions()
      .filter((session) => session.status === "waiting" && !assistantDispatcher?.isDispatcher(session))
      .map((session) => session.name)
  };
  const reply = await completeOnce({ ...buildGreetingRequest(facts), maxTokens: 160, label: "greeting" });
  const text = cleanGreeting(reply) ?? greetingFallback(facts);
  const result = await speechService.speak(text, { lang: facts.lang });
  if (!result.ok) return;
  announceToAssistant(text);
  writeLastGreeted(file, Date.now());
  // The greeting ends with "що робимо сьогодні?": listen for the answer.
  const answer = await listenAfterSpeech();
  if (answer) handleVoiceCommand(answer);
}

function handleVoiceCommand(text: string): void {
  const sleep = matchSleepCommand(text);
  if (sleep) {
    setAssistantAsleep(sleep === "sleep");
    return;
  }
  enableAssistantOnce();
  assistantDispatcher?.submit(text);
  speechService?.warmUp();
}

// Opens the mic once Marshal stops talking, no key needed (#375); null when nobody answered.
async function listenAfterSpeech(): Promise<string | null> {
  if (!speechService || !dictationService || assistantInputs.asleep) return null;
  const quiet = await Promise.race([
    speechService.whenQuiet().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ANSWER_QUIET_WAIT_MS))
  ]);
  if (!quiet || !(await openMicAllowed(openMicState()))) return null;
  return dictationService.listenForAnswer();
}

async function askOwner(question: string): Promise<string | null> {
  if (!speechService || assistantInputs.asleep) return null;
  const spoken = await speechService.speak(question, { key: "assistant:ask" });
  if (!spoken.ok) return null;
  announceToAssistant(question);
  return listenAfterSpeech();
}

// A PermissionRequest hook waits on this (#375): a permission prompt or an
// AskUserQuestion dialog, one at a time; "" = the session shows its own.
async function answerPermissionByVoice(raw: string): Promise<string> {
  const request = parsePermissionRequest(raw);
  const settings = loadSettings();
  if (!request || !settings.assistantDispatcher || !settings.speechEnabled || assistantInputs.asleep) return "";
  if (!isUnderRoots(request.cwd, parseRoutingRoots(settings.claudeCodeRoutingRoots))) return "";
  const question = voiceQuestion(request);
  if (!question && !isVoicePermission(request)) return "";
  const startedAt = Date.now();
  const late = () => Date.now() - startedAt > PERMISSION_DEADLINE_MS;
  const turn = permissionTurn.then(async (): Promise<string> => {
    if (late() || assistantInputs.asleep) return "";
    const name = listLiveSessions().find((session) => session.sessionId === request.sessionId)?.name ?? path.basename(request.cwd);
    const lang = uiLanguage();
    const uk = lang === "uk";
    permissionAskedAt.set(request.sessionId, Date.now());
    const answer = await askOwner(question ? describeQuestion(name, question, lang) : describePermission(name, request, lang));
    if (late()) return "";
    if (question) {
      const index = answer ? matchQuestionAnswer(answer, question.labels) : null;
      if (index !== null) sayAsAssistant(uk ? `Відповів: ${question.labels[index]}.` : `Answered: ${question.labels[index]}.`);
      else if (answer) sayAsAssistant(uk ? "Не зрозумів, відповідь у сесії." : "Didn't get that, answer in the session.");
      return questionHookOutput(request, question, index);
    }
    const decision = answer ? classifyPermissionAnswer(answer) : null;
    if (decision) sayAsAssistant(uk ? (decision === "allow" ? "Дозволив." : "Відмовив.") : decision === "allow" ? "Allowed." : "Declined.");
    else if (answer) sayAsAssistant(uk ? "Не зрозумів, відповідь у сесії." : "Didn't get that, answer in the session.");
    return permissionHookOutput(decision);
  });
  permissionTurn = turn.catch(() => "");
  const deadline = new Promise<string>((resolve) => setTimeout(() => resolve(""), PERMISSION_DEADLINE_MS - (Date.now() - startedAt)));
  return Promise.race([turn, deadline]);
}

// Asleep (#375): nothing is spoken unless the owner asked for it; push-to-talk still works.
function setAssistantAsleep(asleep: boolean): void {
  const uk = uiLanguage() === "uk";
  if (asleep) {
    speechService?.stop();
    sayAsAssistant(uk ? "Добре, сплю." : "Okay, going to sleep.");
  }
  saveSettings({ assistantAsleep: asleep });
  setAssistantInputs({ asleep });
  if (!asleep) sayAsAssistant(uk ? "Я тут." : "I'm here.");
  void refreshTrayState();
}

function sayAsAssistant(text: string): void {
  announceToAssistant(text);
  void speechService?.speak(text);
}

function speakSessionEvent(event: SpokenSessionEvent): void {
  assistantDispatcher?.noteSessionEvent(event.sessionId, event.kind);
  // A finished turn is spoken only when it answers a voice command; a waiting session blocks work, so always (#359).
  const asked = assistantDispatcher?.answersVoiceCommand(event.sessionId, event.kind === "finished") ?? false;
  if (event.kind === "finished" && !asked && (event.name !== GENERAL_NAME || assistantInputs.asleep)) return;
  if (event.kind === "waiting" && assistantInputs.asleep) return;
  if (event.kind === "waiting" && Date.now() - (permissionAskedAt.get(event.sessionId) ?? 0) < PERMISSION_ASKED_QUIET_MS) return;
  const uk = uiLanguage() === "uk";
  if (event.kind === "finished") {
    const summary = event.summary ?? (uk ? "готово" : "finished");
    // `general` answers the owner's own question: its name is noise.
    void speechService?.speak(event.name === GENERAL_NAME ? summary : `${event.name}: ${summary}`, { key: `session:${event.name}` });
    return;
  }
  waitingSignals.set(event.sessionId, { project: projectOf(event.cwd), confirmation: event.confirmation, message: event.message });
  waitingFlush ??= setTimeout(flushWaitingSpeech, WAITING_COALESCE_MS);
}

// One sentence per burst of waiting events, by project (#385). The registry has the
// count and "input needed" for AskUserQuestion; it may lag the hook, so the burst's
// own sessions count even before the registry lists them as waiting.
function flushWaitingSpeech(): void {
  waitingFlush = null;
  const burst = new Map(waitingSignals);
  waitingSignals.clear();
  // A phrase still queued would be replaced by this one: keep its projects in.
  if (!speechService?.isQueued(WAITING_SPEECH_KEY)) waitingProjectsUnspoken.clear();
  for (const signal of burst.values()) waitingProjectsUnspoken.add(signal.project);
  if (assistantInputs.asleep) return;
  const now = Date.now();
  const quiet = (sessionId: string) => now - (permissionAskedAt.get(sessionId) ?? 0) < PERMISSION_ASKED_QUIET_MS;
  const waiting = listLiveSessions().filter((session) => session.status === "waiting");
  for (const sessionId of lastWaitingSignal.keys()) {
    if (!waiting.some((session) => session.sessionId === sessionId)) lastWaitingSignal.delete(sessionId);
  }
  const sessions = new Map<string, WaitingSession>();
  for (const session of waiting) {
    const project = projectOf(session.cwd);
    if (!waitingProjectsUnspoken.has(project) || quiet(session.sessionId)) continue;
    const signal = burst.get(session.sessionId) ?? lastWaitingSignal.get(session.sessionId);
    const question = isQuestionWait({ confirmation: signal?.confirmation ?? true, message: signal?.message ?? "", waitingFor: session.waitingFor });
    sessions.set(session.sessionId, { project, question });
  }
  for (const [sessionId, signal] of burst) {
    lastWaitingSignal.set(sessionId, signal);
    if (!sessions.has(sessionId) && !quiet(sessionId)) sessions.set(sessionId, { project: signal.project, question: isQuestionWait({ ...signal, waitingFor: null }) });
  }
  if (sessions.size === 0) return;
  const lang = uiLanguage();
  void speechService?.speak(describeWaiting([...sessions.values()], lang), { lang, key: WAITING_SPEECH_KEY });
}

async function assistantVoiceAction(action: string): Promise<string> {
  const uk = uiLanguage() === "uk";
  const t = (ukText: string, enText: string) => (uk ? ukText : enText);
  let reply: string;
  switch (action) {
    case "translator":
      runAssistantAction("translator");
      reply = t("Відкрив перекладач.", "The translator is open.");
      break;
    case "captions": {
      const wasOn = captionsService?.isRunning() ?? false;
      await toggleLiveCaptions();
      reply = wasOn ? t("Субтитри вимкнено.", "Captions are off.") : t("Субтитри увімкнено.", "Captions are on.");
      break;
    }
    case "record-call":
    case "record-screen": {
      const wasOn = isMeetingRecording;
      await toggleMeetingRecording(action === "record-screen" ? "screen" : "audio");
      reply = wasOn ? t("Запис зупинено.", "Recording stopped.")
        : isMeetingRecording ? t("Записую.", "Recording.")
        : t("Запис не стартував.", "The recording did not start.");
      break;
    }
    case "recordings":
      runAssistantAction("recordings");
      reply = t("Відкрив записи дзвінків.", "Meeting recordings are open.");
      break;
    case "capture":
      runAssistantAction("capture");
      reply = t("Виділи область.", "Select an area.");
      break;
    case "settings":
      runAssistantAction("settings");
      reply = t("Відкрив налаштування.", "Settings are open.");
      break;
    case "skip":
      speechService?.skip();
      return "ok";
    case "next-meeting": {
      const meeting = calendarService?.nextMeeting() ?? null;
      const time = meeting?.start.toLocaleTimeString(uk ? "uk-UA" : "en-GB", { hour: "2-digit", minute: "2-digit" });
      reply = meeting
        ? t(`Наступна зустріч «${meeting.title}» о ${time}.`, `Next meeting: "${meeting.title}" at ${time}.`)
        : t("Найближчих зустрічей немає.", "No upcoming meetings.");
      break;
    }
    case "join-meeting": {
      const meeting = calendarService?.nextMeeting() ?? null;
      if (meeting?.link) {
        // classifyMeetingUrl lets only https links to known meeting hosts through.
        void shell.openExternal(meeting.link.url);
        reply = t(`Підключаю до «${meeting.title}».`, `Joining "${meeting.title}".`);
      } else {
        reply = t("Немає зустрічі з посиланням.", "No meeting with a link.");
      }
      break;
    }
    default:
      return `Unknown action "${action}". Known: translator, captions, record-call, record-screen, recordings, capture, settings, skip, next-meeting, join-meeting.`;
  }
  sayAsAssistant(reply);
  return reply;
}

function refreshAssistantSessions(): void {
  // The dispatcher routes, it is not one of the owner's sessions.
  const live = listLiveSessions().filter((session) => !assistantDispatcher?.isDispatcher(session));
  setAssistantInputs(sessionCounts(live));
  countWaitingSessions();
  const groups = groupSessions(live);
  assistantHome?.update({ sessions: groups });
  miniWidget?.update({ cards: widgetCards(groups) });
}

// Claude Code rewrites ~/.claude/sessions/<pid>.json on every status change.
// Watched only while the home window is open: nothing runs in idle (#281).
function watchAssistantSessions(open: boolean): void {
  if (sessionsRefresh) clearTimeout(sessionsRefresh);
  sessionsRefresh = null;
  sessionsWatcher?.close();
  sessionsWatcher = null;
  if (!open) return;
  refreshAssistantSessions();
  try {
    sessionsWatcher = fs.watch(defaultSessionsDir(), () => {
      // One status change rewrites the file a few times; read once after the burst.
      if (sessionsRefresh) clearTimeout(sessionsRefresh);
      sessionsRefresh = setTimeout(() => {
        sessionsRefresh = null;
        refreshAssistantSessions();
      }, SESSIONS_REFRESH_DEBOUNCE_MS);
    });
    sessionsWatcher.on("error", (err) => {
      console.warn("[assistant] sessions watcher stopped:", err.message);
      sessionsWatcher?.close();
      sessionsWatcher = null;
    });
  } catch (err) {
    // No Claude Code on this Mac yet: the panel stays empty.
    console.warn("[assistant] cannot watch sessions:", err instanceof Error ? err.message : err);
  }
}

// Dock of the assistant home: every button reuses what the tray already does.
function runAssistantAction(name: string | undefined): void {
  switch (name) {
    case "dictate-session":
      void talkToAssistant();
      return;
    case "translator":
      openTranslator();
      return;
    case "captions":
      void toggleLiveCaptions();
      return;
    case "record-call":
      void toggleMeetingRecording("audio");
      return;
    case "recordings":
      meetingHistoryWindow?.open();
      return;
    case "capture":
      // The home window floats above everything and would land in the shot.
      assistantHome?.close();
      void runCapture("area");
      return;
    case "settings":
      openAssistantHome();
      assistantHome?.showSettings();
      return;
    case "toggle-speech":
      saveSettings({ speechEnabled: !loadSettings().speechEnabled });
      pushAssistantStrip();
      return;
    case "toggle-language":
      saveSettings({ assistantLanguage: uiLanguage() === "uk" ? "en" : "uk" });
      broadcastUiLanguage();
      pushAssistantStrip();
      return;
    case "dispatcher-terminal":
      void showDispatcherTerminal();
      return;
    case "skip-speech":
      speechService?.skip();
      return;
    case "open-home":
      openAssistantHome();
      return;
    case "join-meeting": {
      const link = calendarService?.nextMeeting()?.link;
      // classifyMeetingUrl lets only https links to known meeting hosts through.
      if (link) void shell.openExternal(link.url);
      return;
    }
    default:
      console.warn("[assistant] unknown action:", name);
  }
}

async function refreshTrayState(): Promise<void> {
  if (!tray) return;

  const health = await backendClient
    .invoke<{ runningTasks: number; queuedTasks: number }>("getHealth")
    .catch(() => null);

  const base = health
    ? t("tray.tooltipTasks", { running: health.runningTasks, queued: health.queuedTasks })
    : t("tray.tooltipUnavailable");

  const status: string[] = [];
  if (modelDownload) status.push(t("tray.tooltipModel", { percent: modelDownload.percent }));
  if (isDictating) status.push(t("tray.tooltipDictating"));
  if (isRecording) status.push(t("tray.tooltipScreen"));
  if (isMeetingRecording) status.push(t("tray.tooltipMeeting"));
  tray.setToolTip(status.length > 0 ? `${base}\n${status.join("\n")}` : base);

  // Swap the menu bar icon itself between an idle (template/grey) glyph and a
  // recording (red) glyph so the active state is obvious at a glance. A small
  // text indicator next to the icon was tried earlier and turned out to be
  // nearly invisible on most setups (#83).
  if (!trayIconIdle) trayIconIdle = createTrayIcon();
  if (!trayIconRecording) trayIconRecording = createRecordingTrayIcon();
  tray.setImage(isDictating || isRecording || isMeetingRecording ? trayIconRecording : trayIconIdle);
  // Text next to the icon: the count of sessions waiting for an answer (#309).
  tray.setTitle(waitingSessionCount > 0 ? String(waitingSessionCount) : "");
  pushAssistantStrip();
  // Meeting recording and captions are the "in a call" signal for the glow.
  updateAmbient();

  // Mirror recording state into every Electron BrowserWindow that subscribed
  // (currently the floating toolbar). Cheap fan-out; no-op if no listeners.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("marshal:toolbar:recording-state-changed", { recording: isRecording });
    }
  }

  // Context menu is opened from the tray right-click handler in createTray().
}

function scheduleTrayRefresh(): void {
  if (trayRefreshTimer) {
    clearInterval(trayRefreshTimer);
  }
  trayRefreshTimer = setInterval(() => {
    void refreshTrayState();
  }, 5000);
}

function createTrayIcon(): Electron.NativeImage {
  // macOS template image: black glyph on transparent background, sized to
  // 18×18 logical points (Electron + macOS auto-adapt for dark/light mode).
  // Use "Template" suffix in filename — Electron recognizes this convention.
  const trayIcon2xPath = path.join(projectRootDir, "assets", "tray-icon-template@2x.png");
  const trayIconPath = path.join(projectRootDir, "assets", "tray-icon-template.png");

  let img: Electron.NativeImage;

  if (fs.existsSync(trayIcon2xPath)) {
    img = nativeImage.createFromPath(trayIcon2xPath);
    img = img.resize({ width: 18, height: 18 });
  } else if (fs.existsSync(trayIconPath)) {
    img = nativeImage.createFromPath(trayIconPath);
    if (img.isEmpty()) img = makeFallbackTrayIcon();
  } else {
    img = makeFallbackTrayIcon();
  }

  // Defensive: an empty NativeImage renders as nothing on macOS — the icon is
  // gone from the menu bar and the user thinks the app is broken. If the file
  // lookups produced an empty image, use the inline glyph.
  if (img.isEmpty()) {
    img = makeFallbackTrayIcon();
  }

  img.setTemplateImage(true);
  return img;
}

/**
 * Recording variant of the tray icon — full-color red, NOT a template image,
 * so it renders in red on both dark and light menu bars instead of getting
 * auto-tinted to the foreground color. Used while dictation or screen capture
 * is active so the user can tell at a glance that the mic or screen is live.
 *
 * Falls back to the default template icon when the asset is missing, which
 * keeps the menu bar from going blank on a stripped-down build.
 */
function createRecordingTrayIcon(): Electron.NativeImage {
  const recording2x = path.join(projectRootDir, "assets", "tray-icon-recording@2x.png");
  const recording1x = path.join(projectRootDir, "assets", "tray-icon-recording.png");

  let img: Electron.NativeImage;
  if (fs.existsSync(recording2x)) {
    img = nativeImage.createFromPath(recording2x);
    img = img.resize({ width: 18, height: 18 });
  } else if (fs.existsSync(recording1x)) {
    img = nativeImage.createFromPath(recording1x);
  } else {
    // Missing asset — degrade to the default template glyph rather than
    // emptying the menu bar.
    return createTrayIcon();
  }

  if (img.isEmpty()) return createTrayIcon();
  // Intentionally NOT a template image — we want it to stay red.
  img.setTemplateImage(false);
  return img;
}

// Cache so we don't re-read PNGs every refreshTrayState() tick.
let trayIconIdle: Electron.NativeImage | null = null;
let trayIconRecording: Electron.NativeImage | null = null;

/**
 * Inline 18×18 "M" glyph used when assets/ is missing or unreadable. SVG
 * created via nativeImage.createFromDataURL is sized by the SVG's intrinsic
 * dimensions, so we declare width/height = 18 to match the standard macOS
 * template icon size — otherwise the menu bar renders the glyph too large or
 * invisible.
 */
function makeFallbackTrayIcon(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 32 32">
    <path d="M8 24V8h3.2l4.8 8.2L20.8 8H24v16h-2.7V13l-4.1 6.9h-2.4L10.7 13V24z" fill="black"/>
  </svg>`;
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
  );
}
