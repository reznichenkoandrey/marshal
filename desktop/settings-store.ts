import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

export type BridgeMode =
  | "claude-cli"
  | "codex-cli"
  | "claude"
  | "api"
  | "claude-web"
  | "playwright"
  | "extension";

export type DictationBackend = "whisper-cpp" | "groq";

export type MarshalSettings = {
  bridgeMode: BridgeMode;
  claudeModel: string;
  codexModel: string;
  dictationEnabled: boolean;
  dictationHotkey: string;
  dictationBackend: DictationBackend;
  dictationAutoPaste: boolean;
};

const DEFAULT_SETTINGS: MarshalSettings = {
  bridgeMode: "claude-cli",
  claudeModel: "sonnet",
  codexModel: "",
  dictationEnabled: true,
  dictationHotkey: "Cmd+Shift+D",
  dictationBackend: "whisper-cpp",
  dictationAutoPaste: false
};

const VALID_DICTATION_BACKENDS: readonly DictationBackend[] = ["whisper-cpp", "groq"];

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

  process.env.MARSHAL_DICTATION_ENABLED = settings.dictationEnabled ? "1" : "0";
  process.env.MARSHAL_DICTATION_HOTKEY = settings.dictationHotkey;
  process.env.MARSHAL_DICTATION_BACKEND = settings.dictationBackend;
  process.env.MARSHAL_DICTATION_AUTOPASTE = settings.dictationAutoPaste ? "1" : "0";
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

  const hotkey = typeof input.dictationHotkey === "string" && input.dictationHotkey.trim().length > 0
    ? input.dictationHotkey.trim()
    : DEFAULT_SETTINGS.dictationHotkey;

  return {
    bridgeMode,
    claudeModel: typeof input.claudeModel === "string" ? input.claudeModel : DEFAULT_SETTINGS.claudeModel,
    codexModel: typeof input.codexModel === "string" ? input.codexModel : DEFAULT_SETTINGS.codexModel,
    dictationEnabled: typeof input.dictationEnabled === "boolean"
      ? input.dictationEnabled
      : DEFAULT_SETTINGS.dictationEnabled,
    dictationHotkey: hotkey,
    dictationBackend,
    dictationAutoPaste: typeof input.dictationAutoPaste === "boolean"
      ? input.dictationAutoPaste
      : DEFAULT_SETTINGS.dictationAutoPaste
  };
}
