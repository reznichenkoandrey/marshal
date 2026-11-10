import { describe, expect, it } from "vitest";

import {
  acceleratorKey,
  assistantHotkeyFromEnv,
  DEFAULT_ASSISTANT_HOTKEY,
  findAcceleratorConflict,
  resolveAssistantLanguage
} from "../desktop/assistant/strip.ts";

describe("assistant strip (#309)", () => {
  it("follows the system language on auto and the choice otherwise", () => {
    expect(resolveAssistantLanguage("auto", ["uk-UA", "en-US"])).toBe("uk");
    expect(resolveAssistantLanguage("auto", ["en-GB"])).toBe("en");
    expect(resolveAssistantLanguage("en", ["uk-UA"])).toBe("en");
    expect(resolveAssistantLanguage("uk", ["en-US"])).toBe("uk");
  });

  it("reads the hotkey from the environment, with off for none", () => {
    expect(assistantHotkeyFromEnv(undefined)).toBe(DEFAULT_ASSISTANT_HOTKEY);
    expect(assistantHotkeyFromEnv("  ")).toBe(DEFAULT_ASSISTANT_HOTKEY);
    expect(assistantHotkeyFromEnv("OFF")).toBeNull();
    expect(assistantHotkeyFromEnv("Control+Alt+K")).toBe("Control+Alt+K");
  });

  it("treats aliases and modifier order as the same accelerator", () => {
    expect(acceleratorKey("CommandOrControl+Alt+T")).toBe(acceleratorKey("Option+Cmd+t"));
    expect(acceleratorKey("Ctrl+S")).not.toBe(acceleratorKey("Cmd+S"));
  });

  it("finds a clash that differs only by Shift, since Electron fires it on macOS", () => {
    const taken = ["CommandOrControl+Alt+Shift+M", "CommandOrControl+Alt+T", "Control+Shift+S"];
    expect(findAcceleratorConflict("CommandOrControl+Alt+M", taken)).toBe("CommandOrControl+Alt+Shift+M");
    expect(findAcceleratorConflict("Command+Option+T", taken)).toBe("CommandOrControl+Alt+T");
    expect(findAcceleratorConflict(DEFAULT_ASSISTANT_HOTKEY, taken)).toBeNull();
  });
});
