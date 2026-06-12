import { describe, expect, it, vi } from "vitest";

import {
  evaluatePostInstallPermissionCheck,
  runPostInstallPermissionCheck,
  type PermissionCheckSnapshot
} from "../desktop/permissions/post-install-check.ts";
import type { MarshalSettings } from "../desktop/settings-store.ts";

const baseSnapshot: PermissionCheckSnapshot = {
  platform: "darwin",
  currentVersion: "0.2.0",
  lastSeenVersion: "0.1.9",
  microphoneStatus: "granted",
  screenStatus: "granted",
  accessibilityTrusted: true
};

function settings(overrides: Partial<MarshalSettings> = {}): MarshalSettings {
  return {
    bridgeMode: "claude-cli",
    claudeModel: "sonnet",
    codexModel: "",
    translatorBackend: "auto",
    appearance: "system",
    dictationEnabled: true,
    dictationHotkey: "RightCmd",
    dictationBackend: "hybrid",
    dictationLanguage: "auto",
    dictationAutoPaste: false,
    dictationHoldDelayMs: 0,
    dictationToggleTapCount: 0,
    dictationPrompt: "",
    dictationMicrophone: "",
    captureDefaultFolder: "",
    launchAtLogin: false,
    launchAtLoginLastError: "",
    checkForUpdatesAutomatic: true,
    lastDismissedVersion: "",
    lastSeenVersion: "",
    ...overrides
  };
}

describe("evaluatePostInstallPermissionCheck", () => {
  it("does not prompt off macOS", () => {
    const decision = evaluatePostInstallPermissionCheck({
      ...baseSnapshot,
      platform: "linux",
      microphoneStatus: "denied",
      screenStatus: "denied",
      accessibilityTrusted: false
    });
    expect(decision.shouldPrompt).toBe(false);
    expect(decision.missing).toEqual([]);
  });

  it("does not prompt twice for the same version", () => {
    const decision = evaluatePostInstallPermissionCheck({
      ...baseSnapshot,
      lastSeenVersion: "0.2.0",
      microphoneStatus: "denied"
    });
    expect(decision.shouldPrompt).toBe(false);
  });

  it("collects missing macOS permission gates after a version change", () => {
    const decision = evaluatePostInstallPermissionCheck({
      ...baseSnapshot,
      microphoneStatus: "denied",
      screenStatus: "not-determined",
      accessibilityTrusted: false
    });
    expect(decision.shouldPrompt).toBe(true);
    expect(decision.missing.map((item) => item.id)).toEqual([
      "microphone",
      "accessibility",
      "screen-recording"
    ]);
  });
});

describe("runPostInstallPermissionCheck", () => {
  it("marks a new version seen when permissions are already ready", async () => {
    const saveSettings = vi.fn((next: Partial<MarshalSettings>) => settings(next));
    const showMessageBox = vi.fn();

    await runPostInstallPermissionCheck({
      currentVersion: "0.2.0",
      loadSettings: () => settings({ lastSeenVersion: "0.1.9" }),
      saveSettings,
      queryPermissions: () => ({
        platform: "darwin",
        microphoneStatus: "granted",
        screenStatus: "granted",
        accessibilityTrusted: true
      }),
      showMessageBox,
      openExternal: vi.fn()
    });

    expect(showMessageBox).not.toHaveBeenCalled();
    expect(saveSettings).toHaveBeenCalledWith({ lastSeenVersion: "0.2.0" });
  });

  it("opens the selected privacy pane and records the version", async () => {
    const saveSettings = vi.fn((next: Partial<MarshalSettings>) => settings(next));
    const openExternal = vi.fn(async () => undefined);

    await runPostInstallPermissionCheck({
      currentVersion: "0.2.0",
      loadSettings: () => settings({ lastSeenVersion: "0.1.9" }),
      saveSettings,
      queryPermissions: () => ({
        platform: "darwin",
        microphoneStatus: "denied",
        screenStatus: "granted",
        accessibilityTrusted: true
      }),
      showMessageBox: vi.fn(async () => ({ response: 0 })),
      openExternal
    });

    expect(openExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    );
    expect(saveSettings).toHaveBeenCalledWith({ lastSeenVersion: "0.2.0" });
  });

  it("re-tests and shows success when permissions become ready", async () => {
    const saveSettings = vi.fn((next: Partial<MarshalSettings>) => settings(next));
    const showMessageBox = vi
      .fn()
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 0 });
    let ready = false;

    await runPostInstallPermissionCheck({
      currentVersion: "0.2.0",
      loadSettings: () => settings({ lastSeenVersion: "0.1.9" }),
      saveSettings,
      queryPermissions: () => {
        if (ready) {
          return {
            platform: "darwin",
            microphoneStatus: "granted",
            screenStatus: "granted",
            accessibilityTrusted: true
          };
        }
        ready = true;
        return {
          platform: "darwin",
          microphoneStatus: "denied",
          screenStatus: "granted",
          accessibilityTrusted: true
        };
      },
      showMessageBox,
      openExternal: vi.fn()
    });

    expect(showMessageBox).toHaveBeenCalledTimes(2);
    expect(showMessageBox.mock.calls[1]?.[0].title).toBe("Marshal permissions are ready");
    expect(saveSettings).toHaveBeenCalledWith({ lastSeenVersion: "0.2.0" });
  });
});
