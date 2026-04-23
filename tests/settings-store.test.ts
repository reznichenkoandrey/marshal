import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  delete process.env.MARSHAL_DICTATION_AUTOPASTE;
});

describe("loadSettings", () => {
  it("returns defaults when file does not exist", () => {
    const s = loadSettings();
    expect(s.bridgeMode).toBe("claude-cli");
    expect(s.claudeModel).toBe("sonnet");
    expect(s.codexModel).toBe("");
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
      dictationEnabled: false,
      dictationHotkey: "Cmd+Shift+Y",
      dictationBackend: "groq",
      dictationAutoPaste: true
    });
    expect(saved).toEqual({
      bridgeMode: "api",
      claudeModel: "opus",
      codexModel: "gpt-5",
      dictationEnabled: false,
      dictationHotkey: "Cmd+Shift+Y",
      dictationBackend: "groq",
      dictationAutoPaste: true
    });
  });

  it("falls back to default dictation fields for invalid values", () => {
    const saved = saveSettings({
      dictationBackend: "bogus" as never,
      dictationHotkey: "   "
    });
    expect(saved.dictationBackend).toBe("whisper-cpp");
    expect(saved.dictationHotkey).toBe("Cmd+Shift+D");
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
});
