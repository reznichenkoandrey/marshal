import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

import { DEFAULT_DICTATION_PROMPT } from "./dictation/whisper-backend.ts";
import type { TranslatorBackendChoice } from "./translator/translator-service.ts";

export type BridgeMode =
  | "claude-cli"
  | "codex-cli"
  | "claude"
  | "api"
  | "claude-web"
  | "playwright"
  | "extension";

export type DictationBackend = "whisper-cpp" | "groq";
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
   * Initial prompt (glossary + style hint) seeded into whisper before each
   * transcription. Empty string disables prompting; leave blank only if the
   * bundled default glossary actively hurts recognition for your vocabulary.
   */
  dictationPrompt: string;
  /**
   * Directory where "quick save" stores captured PNGs. Empty string → use
   * ~/Desktop.
   */
  captureDefaultFolder: string;
  /**
   * Launch Marshal automatically when the user logs into macOS. Applied via
   * `app.setLoginItemSettings({ openAtLogin })` — survives reboots and is
   * managed by macOS, not by a launchd plist we have to maintain ourselves.
   */
  launchAtLogin: boolean;
};

const DEFAULT_SETTINGS: MarshalSettings = {
  bridgeMode: "claude-cli",
  claudeModel: "sonnet",
  codexModel: "",
  // Default: follow whichever "Reasoning provider" the user picked. Keeps the
  // translator and the main chat billed to the same account without asking the
  // user to duplicate their choice.
  translatorBackend: "auto",
  appearance: "system",
  dictationEnabled: true,
  dictationHotkey: "RightCmd",
  dictationBackend: "whisper-cpp",
  dictationLanguage: "auto",
  dictationAutoPaste: false,
  dictationPrompt: DEFAULT_DICTATION_PROMPT,
  captureDefaultFolder: "",
  launchAtLogin: false
};

const VALID_DICTATION_BACKENDS: readonly DictationBackend[] = ["whisper-cpp", "groq"];
const VALID_DICTATION_LANGUAGES: readonly DictationLanguage[] = ["auto", "uk", "en"];
const VALID_APPEARANCES: readonly Appearance[] = ["light", "dark", "system"];
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

  process.env.MARSHAL_DICTATION_ENABLED = settings.dictationEnabled ? "1" : "0";
  process.env.MARSHAL_DICTATION_HOTKEY = settings.dictationHotkey;
  process.env.MARSHAL_DICTATION_BACKEND = settings.dictationBackend;
  process.env.MARSHAL_DICTATION_LANGUAGE = settings.dictationLanguage;
  process.env.MARSHAL_DICTATION_AUTOPASTE = settings.dictationAutoPaste ? "1" : "0";
  process.env.MARSHAL_DICTATION_PROMPT = settings.dictationPrompt;
  // Forwarded to the backend utility process so the local bridge server can
  // persist captures (e.g. /capture/fullpage from the Chrome extension) into
  // the same folder the rest of the capture pipeline uses.
  if (settings.captureDefaultFolder) {
    process.env.MARSHAL_CAPTURE_FOLDER = settings.captureDefaultFolder;
  } else {
    delete process.env.MARSHAL_CAPTURE_FOLDER;
  }
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

  const appearanceCandidate = typeof input.appearance === "string"
    ? input.appearance.trim().toLowerCase()
    : DEFAULT_SETTINGS.appearance;
  const appearance = (VALID_APPEARANCES as readonly string[]).includes(appearanceCandidate)
    ? (appearanceCandidate as Appearance)
    : DEFAULT_SETTINGS.appearance;

  return {
    bridgeMode,
    claudeModel: typeof input.claudeModel === "string" ? input.claudeModel : DEFAULT_SETTINGS.claudeModel,
    codexModel: typeof input.codexModel === "string" ? input.codexModel : DEFAULT_SETTINGS.codexModel,
    translatorBackend,
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
    dictationPrompt: typeof input.dictationPrompt === "string"
      ? input.dictationPrompt
      : DEFAULT_SETTINGS.dictationPrompt,
    captureDefaultFolder: typeof input.captureDefaultFolder === "string"
      ? input.captureDefaultFolder
      : DEFAULT_SETTINGS.captureDefaultFolder,
    launchAtLogin: typeof input.launchAtLogin === "boolean"
      ? input.launchAtLogin
      : DEFAULT_SETTINGS.launchAtLogin
  };
}
