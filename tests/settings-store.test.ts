import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_DICTATION_PROMPT } from "../desktop/dictation/whisper-backend.ts";

// Electron's real `app.getPath("userData")` needs a running app instance.
// Stub it with a tmp dir that we clean up after each test.
let tempUserData = "";

vi.mock("electron", () => ({
  app: {
    getPath: (_key: string) => tempUserData
  }
}));

// Import AFTER vi.mock so the mocked electron module is used.
const { loadSettings, saveSettings, applySettingsToEnv } = await import("../desktop/settings-store.ts");

beforeEach(() => {
  tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-settings-"));
});

afterEach(() => {
  fs.rmSync(tempUserData, { recursive: true, force: true });
  delete process.env.MARSHAL_BRIDGE_MODE;
  delete process.env.MARSHAL_CLAUDE_MODEL;
  delete process.env.MARSHAL_CODEX_MODEL;
  delete process.env.MARSHAL_DICTATION_ENABLED;
  delete process.env.MARSHAL_DICTATION_HOTKEY;
  delete process.env.MARSHAL_DICTATION_BACKEND;
  delete process.env.MARSHAL_DICTATION_LANGUAGE;
  delete process.env.MARSHAL_DICTATION_AUTOPASTE;
  delete process.env.MARSHAL_DICTATION_PROMPT;
  delete process.env.MARSHAL_TRANSLATOR_BACKEND;
});

describe("loadSettings", () => {
  it("returns defaults when file does not exist", () => {
    const s = loadSettings();
    expect(s.bridgeMode).toBe("claude-cli");
    expect(s.claudeModel).toBe("sonnet");
    expect(s.codexModel).toBe("");
    expect(s.dictationHotkey).toBe("RightCmd");
  });

  it("returns defaults when file is corrupt", () => {
    fs.writeFileSync(path.join(tempUserData, "settings.json"), "not json {{{");
    const s = loadSettings();
    expect(s.bridgeMode).toBe("claude-cli");
  });
});

describe("saveSettings", () => {
  it("persists merged settings", () => {
    saveSettings({ bridgeMode: "codex-cli", codexModel: "gpt-5" });
    const s = loadSettings();
    expect(s.bridgeMode).toBe("codex-cli");
    expect(s.codexModel).toBe("gpt-5");
  });

  it("falls back to default bridgeMode for unknown values", () => {
    const s = saveSettings({ bridgeMode: "bogus" as never });
    expect(s.bridgeMode).toBe("claude-cli");
  });

  it("writes the file with 0600 permissions on POSIX systems", () => {
    if (process.platform === "win32") return; // chmod is a no-op on Windows
    saveSettings({ bridgeMode: "claude" });
    const filePath = path.join(tempUserData, "settings.json");
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("round-trips all fields", () => {
    const saved = saveSettings({
      bridgeMode: "api",
      claudeModel: "opus",
      codexModel: "gpt-5",
      translatorBackend: "codex-cli",
      appearance: "dark",
      dictationEnabled: false,
      dictationHotkey: "Cmd+Shift+Y",
      dictationBackend: "groq",
      dictationLanguage: "uk",
      dictationAutoPaste: true,
      dictationPrompt: "React, Magento, PR"
    });
    expect(saved).toEqual({
      bridgeMode: "api",
      claudeModel: "opus",
      codexModel: "gpt-5",
      translatorBackend: "codex-cli",
      appearance: "dark",
      dictationEnabled: false,
      dictationHotkey: "Cmd+Shift+Y",
      dictationBackend: "groq",
      dictationLanguage: "uk",
      dictationAutoPaste: true,
      dictationPrompt: "React, Magento, PR",
      captureDefaultFolder: "",
      launchAtLogin: false,
      checkForUpdatesAutomatic: true,
      lastDismissedVersion: ""
    });
  });

  it("round-trips checkForUpdatesAutomatic and lastDismissedVersion", () => {
    const saved = saveSettings({
      checkForUpdatesAutomatic: false,
      lastDismissedVersion: "0.2.0"
    });
    expect(saved.checkForUpdatesAutomatic).toBe(false);
    expect(saved.lastDismissedVersion).toBe("0.2.0");
  });

  it("falls back to default checkForUpdatesAutomatic for non-boolean values", () => {
    const saved = saveSettings({ checkForUpdatesAutomatic: "no" as unknown as boolean });
    expect(saved.checkForUpdatesAutomatic).toBe(true);
  });

  it("defaults launchAtLogin to false", () => {
    const s = saveSettings({});
    expect(s.launchAtLogin).toBe(false);
  });

  it("round-trips launchAtLogin true", () => {
    saveSettings({ launchAtLogin: true });
    expect(loadSettings().launchAtLogin).toBe(true);
  });

  it("falls back to default launchAtLogin for non-boolean values", () => {
    const saved = saveSettings({ launchAtLogin: "yes" as unknown as boolean });
    expect(saved.launchAtLogin).toBe(false);
  });

  it("defaults dictationPrompt to the bundled dev-glossary", () => {
    const s = saveSettings({});
    expect(s.dictationPrompt).toBe(DEFAULT_DICTATION_PROMPT);
  });

  it("preserves empty dictationPrompt (explicit disable)", () => {
    const s = saveSettings({ dictationPrompt: "" });
    expect(s.dictationPrompt).toBe("");
  });

  it("falls back to default dictation fields for invalid values", () => {
    const saved = saveSettings({
      dictationBackend: "bogus" as never,
      dictationLanguage: "fr" as never,
      dictationHotkey: "   "
    });
    // Default changed to hybrid (#93) — Groq with local fallback when API key
    // is set, else falls back to whisper-cpp via resolveBackendName.
    expect(saved.dictationBackend).toBe("hybrid");
    expect(saved.dictationLanguage).toBe("auto");
    expect(saved.dictationHotkey).toBe("RightCmd");
  });

  it("falls back to auto for invalid translatorBackend", () => {
    const saved = saveSettings({ translatorBackend: "mistral" as never });
    expect(saved.translatorBackend).toBe("auto");
  });

  it("accepts `auto` as a valid translatorBackend", () => {
    const saved = saveSettings({ translatorBackend: "auto" });
    expect(saved.translatorBackend).toBe("auto");
  });

  it("accepts the new claude-api / openai-api backends", () => {
    expect(saveSettings({ translatorBackend: "claude-api" }).translatorBackend).toBe("claude-api");
    expect(saveSettings({ translatorBackend: "openai-api" }).translatorBackend).toBe("openai-api");
  });
});

describe("applySettingsToEnv", () => {
  it("sets MARSHAL_BRIDGE_MODE", () => {
    applySettingsToEnv({ bridgeMode: "codex-cli", claudeModel: "", codexModel: "" });
    expect(process.env.MARSHAL_BRIDGE_MODE).toBe("codex-cli");
  });

  it("sets model env vars when non-empty", () => {
    applySettingsToEnv({ bridgeMode: "claude-cli", claudeModel: "opus", codexModel: "gpt-5" });
    expect(process.env.MARSHAL_CLAUDE_MODEL).toBe("opus");
    expect(process.env.MARSHAL_CODEX_MODEL).toBe("gpt-5");
  });

  it("unsets model env vars when empty", () => {
    process.env.MARSHAL_CLAUDE_MODEL = "leftover";
    process.env.MARSHAL_CODEX_MODEL = "leftover";
    applySettingsToEnv({ bridgeMode: "claude-cli", claudeModel: "", codexModel: "" });
    expect(process.env.MARSHAL_CLAUDE_MODEL).toBeUndefined();
    expect(process.env.MARSHAL_CODEX_MODEL).toBeUndefined();
  });

  it("sets MARSHAL_TRANSLATOR_BACKEND", () => {
    applySettingsToEnv({
      bridgeMode: "claude-cli",
      claudeModel: "",
      codexModel: "",
      translatorBackend: "codex-cli",
      dictationEnabled: true,
      dictationHotkey: "RightCmd",
      dictationBackend: "whisper-cpp",
      dictationLanguage: "auto",
      dictationAutoPaste: false,
      dictationPrompt: ""
    });
    expect(process.env.MARSHAL_TRANSLATOR_BACKEND).toBe("codex-cli");
  });
});
