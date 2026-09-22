import { describe, expect, it, vi } from "vitest";

import {
  evaluatePostInstallPermissionCheck,
  isActivelyBlocked,
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

// #174: the reported bug. The app never asks for the microphone itself (#82),
// so its own status sits at "not-determined" forever while the audio-recorder
// helper holds the real grant. Treating that as "missing" made the dialog fire
// on every version bump — five times over 0.2.5 → 0.2.9 — with dictation
// working the whole time.
describe("microphone: not-determined must not raise the dialog", () => {
  it("stays quiet when only the app's own microphone status is undetermined", () => {
    const decision = evaluatePostInstallPermissionCheck({
      ...baseSnapshot,
      microphoneStatus: "not-determined"
    });
    expect(decision.shouldPrompt).toBe(false);
    expect(decision.missing).toEqual([]);
  });

  it("still speaks up when the microphone was actively refused", () => {
    for (const status of ["denied", "restricted"] as const) {
      const decision = evaluatePostInstallPermissionCheck({
        ...baseSnapshot,
        microphoneStatus: status
      });
      expect(decision.shouldPrompt).toBe(true);
      expect(decision.missing.map((m) => m.id)).toEqual(["microphone"]);
      expect(decision.missing[0].status).toBe(status);
    }
  });

  it("does not mask the other two permissions, which the app does hold itself", () => {
    const decision = evaluatePostInstallPermissionCheck({
      ...baseSnapshot,
      microphoneStatus: "not-determined",
      accessibilityTrusted: false,
      screenStatus: "not-determined"
    });
    expect(decision.shouldPrompt).toBe(true);
    expect(decision.missing.map((m) => m.id)).toEqual(["accessibility", "screen-recording"]);
  });
});

describe("isActivelyBlocked", () => {
  it("separates a refusal from never having been asked", () => {
    expect(isActivelyBlocked("denied")).toBe(true);
    expect(isActivelyBlocked("restricted")).toBe(true);
    expect(isActivelyBlocked("not-determined")).toBe(false);
    expect(isActivelyBlocked("granted")).toBe(false);
    expect(isActivelyBlocked("unknown")).toBe(false);
  });
});
