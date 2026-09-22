import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

import {
  DEFAULT_HOLD_DELAY_MS,
  DEFAULT_TOGGLE_TAP_COUNT,
  normalizeToggleTapCount
} from "./dictation/gesture-options.ts";
import { DEFAULT_DICTATION_PROMPT } from "./dictation/whisper-backend.ts";
import {
  DEFAULT_CAPTIONS_DRAG_MODIFIER,
  DEFAULT_CAPTIONS_HOTKEY,
  DEFAULT_CAPTIONS_OCR_HOTKEY,
  DEFAULT_CAPTIONS_PROMPT,
  DEFAULT_CAPTIONS_SILENCE_MS,
  MAX_CAPTIONS_SILENCE_MS,
  MIN_CAPTIONS_SILENCE_MS,
  VALID_CAPTIONS_PROVIDERS,
  VALID_CAPTIONS_STT,
  VALID_CAPTIONS_VAD,
  type CaptionsProviderChoice,
  type CaptionsSttChoice,
  type CaptionsVadChoice
} from "./captions/captions-defaults.ts";
import {
  resolveLangCode,
  resolveSourceLang as resolveSourceLangCode
} from "./translator/languages.ts";
import type { LangCode, SourceLang } from "./translator/languages.ts";
import type { Formality, TranslatorBackendChoice } from "./translator/translator-service.ts";

export type BridgeMode =
  | "claude-cli"
  | "codex-cli"
  | "claude"
  | "api"
  | "claude-web"
  | "playwright"
  | "extension";

export type DictationBackend = "whisper-cpp" | "groq" | "hybrid";
// "auto" → let whisper detect the language per clip.
// Explicit codes pin the decoder to a single language, which is noticeably
// more accurate on short utterances where auto-detection can flip between
// similar scripts (e.g. Ukrainian vs Russian).
export type DictationLanguage = "auto" | "uk" | "en";

export type Appearance = "light" | "dark" | "system";

export type MarshalSettings = {
  bridgeMode: BridgeMode;
  claudeModel: string;
  codexModel: string;
  translatorBackend: TranslatorBackendChoice;
  /**
   * Language pair the translator window opens on, and the direction the
   * ⌘⌥T / double-⌘C hotkeys translate in. `"auto"` on the source side lets
   * the model detect it.
   */
  translatorSourceLang: SourceLang;
  translatorTargetLang: LangCode;
  /** Register requested from the model — DeepL's formal/informal switch. */
  translatorFormality: Formality;
  /**
   * UI appearance preference. `"system"` follows the OS `prefers-color-scheme`
   * at paint time; explicit values force the theme regardless of OS setting.
   */
  appearance: Appearance;
  dictationEnabled: boolean;
  dictationHotkey: string;
  dictationBackend: DictationBackend;
  dictationLanguage: DictationLanguage;
  dictationAutoPaste: boolean;
  /**
   * Delay before a physical hold starts recording. Suppresses accidental taps
   * and mirrors the more deliberate push-to-talk feel of native dictation apps.
   */
  dictationHoldDelayMs: number;
  /**
   * 0 disables hands-free tapping. 2 or 3 means double/triple tap the PTT key
   * to toggle recording on/off without holding the key down.
   */
  dictationToggleTapCount: number;
  /**
   * Initial prompt (glossary + style hint) seeded into whisper before each
   * transcription. Empty string disables prompting; leave blank only if the
   * bundled default glossary actively hurts recognition for your vocabulary.
   */
  dictationPrompt: string;
  /**
   * Core Audio unique device ID of the microphone dictation records from.
   * Empty string ("") means "track the system default" — same behavior the
   * app shipped with before #95. When non-empty, audio-recorder temporarily
   * sets this device as the system default input for the duration of the
   * capture and restores the previous default on shutdown.
   */
  dictationMicrophone: string;
  /**
   * Live captions (#176). Mirrors the MARSHAL_CAPTIONS_* env vars so a
   * packaged-app user does not have to edit .env (#179). Empty strings and
   * `auto` mean "fall back to the env / the dictation setting".
   */
  captionsProvider: CaptionsProviderChoice;
  /** Chat model for the summary; empty → MARSHAL_TRANSLATOR_MODEL / provider default. */
  captionsModel: string;
  /** Language the bullets are written in; empty → same as the transcript. */
  captionsOutputLanguage: string;
  captionsSttBackend: CaptionsSttChoice;
  captionsLanguage: DictationLanguage;
  /** Whisper initial prompt for captions; empty disables prompting. */
  captionsPrompt: string;
  /** Modifier held to move the overlay; `off` disables the listener. */
  captionsDragModifier: string;
  captionsHotkey: string;
  captionsOcrHotkey: string;
  /** Per-frame speech detector; `energy` is the fallback when the WASM VAD cannot load. */
  captionsVad: CaptionsVadChoice;
  /** Trailing silence (ms) that ends an utterance and triggers the summary. */
  captionsSilenceMs: number;
  /**
   * Directory where "quick save" stores captured PNGs. Empty string → use
   * ~/Desktop.
   */
  captureDefaultFolder: string;
  /**
   * Keep the capture editor above other windows. On by default: Marshal is an
   * LSUIElement app, so a normal window that slips behind another one has no
   * Dock icon or app-switcher entry to bring it back (#168).
   */
  captureEditorAlwaysOnTop: boolean;
  /**
   * Launch Marshal automatically when the user logs into macOS. Applied via
   * `app.setLoginItemSettings({ openAtLogin })` — survives reboots and is
   * managed by macOS, not by a launchd plist we have to maintain ourselves.
   */
  launchAtLogin: boolean;
  /**
   * Last macOS/Windows Login Item reconciliation failure. Empty string means
   * the persisted preference matches what the OS reports, or the feature is
   * disabled. Kept in settings so Setup Health can surface failures discovered
   * during startup before the Settings modal is opened.
   */
  launchAtLoginLastError: string;
  /**
   * Check the GitHub Releases API on a schedule and surface new versions as
   * a tray notification. Disabling this only stops the silent background
   * check; the manual "Check for updates…" tray entry still works.
   */
  checkForUpdatesAutomatic: boolean;
  /**
   * Tag of the most recent release the user dismissed ("Skip this version").
   * Suppresses repeat notifications for that one version. Cleared on every
   * subsequent newer release so the user sees the next one.
   */
  lastDismissedVersion: string;
  /**
   * App version whose post-update permission check has already been surfaced.
   * Self-signed macOS builds can lose TCC grants after replacement; this
   * keeps the warning one-shot per app version instead of nagging forever.
   */
  lastSeenVersion: string;
};

const DEFAULT_SETTINGS: MarshalSettings = {
  bridgeMode: "claude-cli",
  claudeModel: "sonnet",
  codexModel: "",
  // Default: follow whichever "Reasoning provider" the user picked. Keeps the
  // translator and the main chat billed to the same account without asking the
  // user to duplicate their choice.
  translatorBackend: "auto",
  translatorSourceLang: "auto",
  translatorTargetLang: "uk",
  translatorFormality: "default",
  appearance: "system",
  dictationEnabled: true,
  dictationHotkey: "RightCmd",
  // Default: hybrid backend (Groq large-v3 with local whisper.cpp fallback).
  // Falls back to whisper-cpp locally if MARSHAL_API_KEY is absent — see
  // resolveBackendName in whisper-backend.ts. See #93.
  dictationBackend: "hybrid",
  dictationLanguage: "auto",
  dictationAutoPaste: false,
  dictationHoldDelayMs: DEFAULT_HOLD_DELAY_MS,
  dictationToggleTapCount: DEFAULT_TOGGLE_TAP_COUNT,
  dictationPrompt: DEFAULT_DICTATION_PROMPT,
  dictationMicrophone: "",
  captionsProvider: "auto",
  captionsModel: "",
  captionsOutputLanguage: "",
  captionsSttBackend: "auto",
  captionsLanguage: "auto",
  captionsPrompt: DEFAULT_CAPTIONS_PROMPT,
  captionsDragModifier: DEFAULT_CAPTIONS_DRAG_MODIFIER,
  captionsHotkey: DEFAULT_CAPTIONS_HOTKEY,
  captionsOcrHotkey: DEFAULT_CAPTIONS_OCR_HOTKEY,
  captionsVad: "silero",
  captionsSilenceMs: DEFAULT_CAPTIONS_SILENCE_MS,
  captureDefaultFolder: "",
  captureEditorAlwaysOnTop: true,
  launchAtLogin: false,
  launchAtLoginLastError: "",
  checkForUpdatesAutomatic: true,
  lastDismissedVersion: "",
  lastSeenVersion: ""
};

const VALID_DICTATION_BACKENDS: readonly DictationBackend[] = ["whisper-cpp", "groq", "hybrid"];
const VALID_DICTATION_LANGUAGES: readonly DictationLanguage[] = ["auto", "uk", "en"];
const VALID_APPEARANCES: readonly Appearance[] = ["light", "dark", "system"];
const VALID_FORMALITIES: readonly Formality[] = ["default", "formal", "informal"];
const VALID_TRANSLATOR_BACKENDS: readonly TranslatorBackendChoice[] = [
  "auto",
  "claude-cli",
  "codex-cli",
  "claude-api",
  "openai-api",
  "groq",
  "apple-vision"
];

const VALID_MODES: readonly BridgeMode[] = [
  "claude-cli",
  "codex-cli",
  "claude",
  "api",
  "claude-web",
  "playwright",
  "extension"
];

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function loadSettings(): MarshalSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<MarshalSettings>;
    return normalize(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Partial<MarshalSettings>): MarshalSettings {
  const merged = normalize({ ...loadSettings(), ...settings });
  const filePath = settingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
  // Owner-only permissions. Settings may later hold API keys or provider
  // credentials; other users on the system should not be able to read them.
  // chmod is a no-op on Windows — wrap in try/catch so we don't crash there.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Permissions model doesn't apply on this platform.
  }
  return merged;
}

export function applySettingsToEnv(settings: MarshalSettings): void {
  process.env.MARSHAL_BRIDGE_MODE = settings.bridgeMode;

  if (settings.claudeModel) {
    process.env.MARSHAL_CLAUDE_MODEL = settings.claudeModel;
  } else {
    delete process.env.MARSHAL_CLAUDE_MODEL;
  }

  if (settings.codexModel) {
    process.env.MARSHAL_CODEX_MODEL = settings.codexModel;
  } else {
    delete process.env.MARSHAL_CODEX_MODEL;
  }

  process.env.MARSHAL_TRANSLATOR_BACKEND = settings.translatorBackend;
  process.env.MARSHAL_TRANSLATOR_SOURCE_LANG = settings.translatorSourceLang;
  process.env.MARSHAL_TRANSLATOR_TARGET_LANG = settings.translatorTargetLang;
  process.env.MARSHAL_TRANSLATOR_FORMALITY = settings.translatorFormality;

  process.env.MARSHAL_DICTATION_ENABLED = settings.dictationEnabled ? "1" : "0";
  process.env.MARSHAL_DICTATION_HOTKEY = settings.dictationHotkey;
  process.env.MARSHAL_DICTATION_BACKEND = settings.dictationBackend;
  process.env.MARSHAL_DICTATION_LANGUAGE = settings.dictationLanguage;
  process.env.MARSHAL_DICTATION_AUTOPASTE = settings.dictationAutoPaste ? "1" : "0";
  process.env.MARSHAL_DICTATION_HOLD_DELAY_MS = String(settings.dictationHoldDelayMs);
  process.env.MARSHAL_DICTATION_TOGGLE_TAP_COUNT = String(settings.dictationToggleTapCount);
  process.env.MARSHAL_DICTATION_PROMPT = settings.dictationPrompt;
  if (settings.dictationMicrophone) {
    process.env.MARSHAL_DICTATION_MIC = settings.dictationMicrophone;
  } else {
    delete process.env.MARSHAL_DICTATION_MIC;
  }
  // Live captions. The service re-reads these on every start, and main
  // re-registers the two accelerators on save, so a change takes effect
  // without an app restart.
  setOrDelete("MARSHAL_CAPTIONS_PROVIDER", settings.captionsProvider);
  setOrDelete("MARSHAL_CAPTIONS_MODEL", settings.captionsModel);
  setOrDelete("MARSHAL_CAPTIONS_OUTPUT_LANGUAGE", settings.captionsOutputLanguage);
  // `auto` = follow the dictation backend, which is the variable the service
  // falls back to when this one is absent.
  setOrDelete("MARSHAL_CAPTIONS_STT_BACKEND", settings.captionsSttBackend === "auto" ? "" : settings.captionsSttBackend);
  setOrDelete("MARSHAL_CAPTIONS_LANGUAGE", settings.captionsLanguage);
  // An empty prompt is a choice (no prompting), not an absence — keep it.
  if (typeof settings.captionsPrompt === "string") process.env.MARSHAL_CAPTIONS_PROMPT = settings.captionsPrompt;
  setOrDelete("MARSHAL_CAPTIONS_DRAG_MODIFIER", settings.captionsDragModifier);
  setOrDelete("MARSHAL_CAPTIONS_HOTKEY", settings.captionsHotkey);
  setOrDelete("MARSHAL_CAPTIONS_OCR_HOTKEY", settings.captionsOcrHotkey);
  setOrDelete("MARSHAL_CAPTIONS_VAD", settings.captionsVad);
  setOrDelete(
    "MARSHAL_CAPTIONS_SILENCE_MS",
    typeof settings.captionsSilenceMs === "number" ? String(settings.captionsSilenceMs) : ""
  );
  // Forwarded to the backend utility process so the local bridge server can
  // persist captures (e.g. /capture/fullpage from the Chrome extension) into
  // the same folder the rest of the capture pipeline uses.
  if (settings.captureDefaultFolder) {
    process.env.MARSHAL_CAPTURE_FOLDER = settings.captureDefaultFolder;
  } else {
    delete process.env.MARSHAL_CAPTURE_FOLDER;
  }
}

/** Blank or absent clears the variable so a stale .env value cannot linger. */
function setOrDelete(name: string, value: string | undefined): void {
  const trimmed = (value ?? "").trim();
  if (trimmed.length > 0) process.env[name] = trimmed;
  else delete process.env[name];
}

function normalize(input: Partial<MarshalSettings>): MarshalSettings {
  const bridgeCandidate = typeof input.bridgeMode === "string" ? input.bridgeMode : DEFAULT_SETTINGS.bridgeMode;
  const bridgeMode = (VALID_MODES as readonly string[]).includes(bridgeCandidate)
    ? (bridgeCandidate as BridgeMode)
    : DEFAULT_SETTINGS.bridgeMode;

  const dictationBackendCandidate = typeof input.dictationBackend === "string"
    ? input.dictationBackend
    : DEFAULT_SETTINGS.dictationBackend;
  const dictationBackend = (VALID_DICTATION_BACKENDS as readonly string[]).includes(dictationBackendCandidate)
    ? (dictationBackendCandidate as DictationBackend)
    : DEFAULT_SETTINGS.dictationBackend;

  const dictationLanguageCandidate = typeof input.dictationLanguage === "string"
    ? input.dictationLanguage
    : DEFAULT_SETTINGS.dictationLanguage;
  const dictationLanguage = (VALID_DICTATION_LANGUAGES as readonly string[]).includes(dictationLanguageCandidate)
    ? (dictationLanguageCandidate as DictationLanguage)
    : DEFAULT_SETTINGS.dictationLanguage;

  const hotkey = typeof input.dictationHotkey === "string" && input.dictationHotkey.trim().length > 0
    ? input.dictationHotkey.trim()
    : DEFAULT_SETTINGS.dictationHotkey;

  const translatorBackendCandidate = typeof input.translatorBackend === "string"
    ? input.translatorBackend.trim().toLowerCase()
    : DEFAULT_SETTINGS.translatorBackend;
  const translatorBackend = (VALID_TRANSLATOR_BACKENDS as readonly string[]).includes(translatorBackendCandidate)
    ? (translatorBackendCandidate as TranslatorBackendChoice)
    : DEFAULT_SETTINGS.translatorBackend;

  const translatorSourceLang = resolveSourceLangCode(
    input.translatorSourceLang,
    DEFAULT_SETTINGS.translatorSourceLang
  );
  const translatorTargetLang = resolveLangCode(
    input.translatorTargetLang,
    DEFAULT_SETTINGS.translatorTargetLang
  );
  const translatorFormality = (VALID_FORMALITIES as readonly string[]).includes(
    typeof input.translatorFormality === "string" ? input.translatorFormality : ""
  )
    ? (input.translatorFormality as Formality)
    : DEFAULT_SETTINGS.translatorFormality;

  const appearanceCandidate = typeof input.appearance === "string"
    ? input.appearance.trim().toLowerCase()
    : DEFAULT_SETTINGS.appearance;
  const appearance = (VALID_APPEARANCES as readonly string[]).includes(appearanceCandidate)
    ? (appearanceCandidate as Appearance)
    : DEFAULT_SETTINGS.appearance;

  const dictationHoldDelayMs = normalizeInteger(
    input.dictationHoldDelayMs,
    DEFAULT_SETTINGS.dictationHoldDelayMs,
    0,
    1_000
  );
  const dictationToggleTapCount = normalizeToggleTapCount(input.dictationToggleTapCount);

  const captionsProviderCandidate = typeof input.captionsProvider === "string"
    ? input.captionsProvider.trim().toLowerCase()
    : DEFAULT_SETTINGS.captionsProvider;
  const captionsProvider = (VALID_CAPTIONS_PROVIDERS as readonly string[]).includes(captionsProviderCandidate)
    ? (captionsProviderCandidate as CaptionsProviderChoice)
    : DEFAULT_SETTINGS.captionsProvider;
  const captionsSttCandidate = typeof input.captionsSttBackend === "string"
    ? input.captionsSttBackend.trim().toLowerCase()
    : DEFAULT_SETTINGS.captionsSttBackend;
  const captionsSttBackend = (VALID_CAPTIONS_STT as readonly string[]).includes(captionsSttCandidate)
    ? (captionsSttCandidate as CaptionsSttChoice)
    : DEFAULT_SETTINGS.captionsSttBackend;
  const captionsLanguageCandidate = typeof input.captionsLanguage === "string"
    ? input.captionsLanguage.trim().toLowerCase()
    : DEFAULT_SETTINGS.captionsLanguage;
  const captionsLanguage = (VALID_DICTATION_LANGUAGES as readonly string[]).includes(captionsLanguageCandidate)
    ? (captionsLanguageCandidate as DictationLanguage)
    : DEFAULT_SETTINGS.captionsLanguage;
  const captionsVadCandidate = typeof input.captionsVad === "string"
    ? input.captionsVad.trim().toLowerCase()
    : DEFAULT_SETTINGS.captionsVad;
  const captionsVad = (VALID_CAPTIONS_VAD as readonly string[]).includes(captionsVadCandidate)
    ? (captionsVadCandidate as CaptionsVadChoice)
    : DEFAULT_SETTINGS.captionsVad;

  return {
    bridgeMode,
    claudeModel: typeof input.claudeModel === "string" ? input.claudeModel : DEFAULT_SETTINGS.claudeModel,
    codexModel: typeof input.codexModel === "string" ? input.codexModel : DEFAULT_SETTINGS.codexModel,
    translatorBackend,
    translatorSourceLang,
    translatorTargetLang,
    translatorFormality,
    appearance,
    dictationEnabled: typeof input.dictationEnabled === "boolean"
      ? input.dictationEnabled
      : DEFAULT_SETTINGS.dictationEnabled,
    dictationHotkey: hotkey,
    dictationBackend,
    dictationLanguage,
    dictationAutoPaste: typeof input.dictationAutoPaste === "boolean"
      ? input.dictationAutoPaste
      : DEFAULT_SETTINGS.dictationAutoPaste,
    dictationHoldDelayMs,
    dictationToggleTapCount,
    dictationPrompt: typeof input.dictationPrompt === "string"
      ? input.dictationPrompt
      : DEFAULT_SETTINGS.dictationPrompt,
    dictationMicrophone: typeof input.dictationMicrophone === "string"
      ? input.dictationMicrophone.trim()
      : DEFAULT_SETTINGS.dictationMicrophone,
    captionsProvider,
    captionsModel: typeof input.captionsModel === "string" ? input.captionsModel.trim() : DEFAULT_SETTINGS.captionsModel,
    captionsOutputLanguage: typeof input.captionsOutputLanguage === "string"
      ? input.captionsOutputLanguage.trim()
      : DEFAULT_SETTINGS.captionsOutputLanguage,
    captionsSttBackend,
    captionsLanguage,
    captionsPrompt: typeof input.captionsPrompt === "string" ? input.captionsPrompt : DEFAULT_SETTINGS.captionsPrompt,
    captionsDragModifier: nonEmptyOr(input.captionsDragModifier, DEFAULT_SETTINGS.captionsDragModifier),
    captionsHotkey: nonEmptyOr(input.captionsHotkey, DEFAULT_SETTINGS.captionsHotkey),
    captionsOcrHotkey: nonEmptyOr(input.captionsOcrHotkey, DEFAULT_SETTINGS.captionsOcrHotkey),
    captionsVad,
    captionsSilenceMs: normalizeInteger(
      input.captionsSilenceMs,
      DEFAULT_SETTINGS.captionsSilenceMs,
      MIN_CAPTIONS_SILENCE_MS,
      MAX_CAPTIONS_SILENCE_MS
    ),
    captureEditorAlwaysOnTop: typeof input.captureEditorAlwaysOnTop === "boolean"
      ? input.captureEditorAlwaysOnTop
      : DEFAULT_SETTINGS.captureEditorAlwaysOnTop,
    captureDefaultFolder: typeof input.captureDefaultFolder === "string"
      ? input.captureDefaultFolder
      : DEFAULT_SETTINGS.captureDefaultFolder,
    launchAtLogin: typeof input.launchAtLogin === "boolean"
      ? input.launchAtLogin
      : DEFAULT_SETTINGS.launchAtLogin,
    launchAtLoginLastError: typeof input.launchAtLoginLastError === "string"
      ? input.launchAtLoginLastError.trim()
      : DEFAULT_SETTINGS.launchAtLoginLastError,
    checkForUpdatesAutomatic: typeof input.checkForUpdatesAutomatic === "boolean"
      ? input.checkForUpdatesAutomatic
      : DEFAULT_SETTINGS.checkForUpdatesAutomatic,
    lastDismissedVersion: typeof input.lastDismissedVersion === "string"
      ? input.lastDismissedVersion
      : DEFAULT_SETTINGS.lastDismissedVersion,
    lastSeenVersion: typeof input.lastSeenVersion === "string"
      ? input.lastSeenVersion
      : DEFAULT_SETTINGS.lastSeenVersion
  };
}

function nonEmptyOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}
