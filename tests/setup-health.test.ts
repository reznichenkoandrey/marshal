import { describe, expect, it } from "vitest";

import { buildSetupHealth } from "../desktop/setup-health.ts";

function ids(summary: ReturnType<typeof buildSetupHealth>): Record<string, string> {
  return Object.fromEntries(summary.items.map((item) => [item.id, item.status]));
}

describe("buildSetupHealth", () => {
  it("marks a fully configured macOS setup as ready", () => {
    const summary = buildSetupHealth({
      platform: "darwin",
      dictationEnabled: true,
      dictationBackend: "hybrid",
      microphoneStatus: "granted",
      screenStatus: "granted",
      accessibilityTrusted: true,
      apiKeyPresent: true,
      whisperBinPath: "/whisper-cli",
      whisperModelPath: "/model.bin",
      codesignIdentityPresent: true,
      launchAtLogin: false,
      launchAtLoginOpenAtLogin: false,
      exists: () => true
    });

    expect(summary.counts.error).toBe(0);
    expect(summary.counts.warn).toBe(0);
    expect(ids(summary)).toMatchObject({
      microphone: "ok",
      accessibility: "ok",
      "screen-recording": "ok",
      "whisper-local": "ok",
      "cloud-api": "ok",
      codesign: "ok",
      "launch-at-login": "ok"
    });
  });

  it("treats missing local Whisper as blocking for hybrid dictation", () => {
    const summary = buildSetupHealth({
      platform: "darwin",
      dictationEnabled: true,
      dictationBackend: "hybrid",
      microphoneStatus: "granted",
      screenStatus: "granted",
      accessibilityTrusted: true,
      apiKeyPresent: true,
      whisperBinPath: "/missing-bin",
      whisperModelPath: "/missing-model",
      codesignIdentityPresent: true,
      launchAtLogin: false,
      launchAtLoginOpenAtLogin: false,
      exists: () => false
    });

    expect(ids(summary)["whisper-local"]).toBe("error");
    expect(summary.counts.error).toBe(1);
  });

  it("treats missing API key as blocking only for Groq-only dictation", () => {
    const groq = buildSetupHealth({
      platform: "darwin",
      dictationEnabled: true,
      dictationBackend: "groq",
      microphoneStatus: "granted",
      screenStatus: "granted",
      accessibilityTrusted: true,
      apiKeyPresent: false,
      whisperBinPath: "/whisper-cli",
      whisperModelPath: "/model.bin",
      codesignIdentityPresent: true,
      launchAtLogin: false,
      launchAtLoginOpenAtLogin: false,
      exists: () => true
    });
    const local = buildSetupHealth({
      platform: "darwin",
      dictationEnabled: true,
      dictationBackend: "whisper-cpp",
      microphoneStatus: "granted",
      screenStatus: "granted",
      accessibilityTrusted: true,
      apiKeyPresent: false,
      whisperBinPath: "/whisper-cli",
      whisperModelPath: "/model.bin",
      codesignIdentityPresent: true,
      launchAtLogin: false,
      launchAtLoginOpenAtLogin: false,
      exists: () => true
    });

    expect(ids(groq)["cloud-api"]).toBe("error");
    expect(ids(local)["cloud-api"]).toBe("ok");
  });

  it("surfaces missing macOS permissions", () => {
    const summary = buildSetupHealth({
      platform: "darwin",
      dictationEnabled: true,
      dictationBackend: "hybrid",
      microphoneStatus: "denied",
      screenStatus: "not-determined",
      accessibilityTrusted: false,
      apiKeyPresent: false,
      whisperBinPath: "/whisper-cli",
      whisperModelPath: "/model.bin",
      codesignIdentityPresent: false,
      launchAtLogin: false,
      launchAtLoginOpenAtLogin: false,
      exists: () => true
    });

    expect(ids(summary)).toMatchObject({
      microphone: "error",
      accessibility: "error",
      "screen-recording": "warn",
      "cloud-api": "warn",
      codesign: "warn"
    });
  });

  it("does not block on dictation-only checks when voice dictation is disabled", () => {
    const summary = buildSetupHealth({
      platform: "darwin",
      dictationEnabled: false,
      dictationBackend: "groq",
      microphoneStatus: "denied",
      screenStatus: "granted",
      accessibilityTrusted: true,
      apiKeyPresent: false,
      whisperBinPath: "/missing-bin",
      whisperModelPath: "/missing-model",
      codesignIdentityPresent: true,
      launchAtLogin: false,
      launchAtLoginOpenAtLogin: false,
      exists: () => false
    });

    expect(ids(summary)).toMatchObject({
      microphone: "ok",
      "whisper-local": "ok",
      "cloud-api": "ok",
      "screen-recording": "ok"
    });
    expect(summary.counts.error).toBe(0);
  });

  it("warns when launch-at-login was requested but the OS rejected it", () => {
    const summary = buildSetupHealth({
      platform: "darwin",
      dictationEnabled: true,
      dictationBackend: "hybrid",
      microphoneStatus: "granted",
      screenStatus: "granted",
      accessibilityTrusted: true,
      apiKeyPresent: true,
      whisperBinPath: "/whisper-cli",
      whisperModelPath: "/model.bin",
      codesignIdentityPresent: true,
      launchAtLogin: true,
      launchAtLoginOpenAtLogin: false,
      launchAtLoginLastError: "Operation not permitted",
      exists: () => true
    });

    const item = summary.items.find((entry) => entry.id === "launch-at-login");
    expect(item?.status).toBe("warn");
    expect(item?.detail).toContain("Operation not permitted");
  });

  it("marks launch-at-login ready when the OS reports it enabled", () => {
    const summary = buildSetupHealth({
      platform: "darwin",
      dictationEnabled: true,
      dictationBackend: "hybrid",
      microphoneStatus: "granted",
      screenStatus: "granted",
      accessibilityTrusted: true,
      apiKeyPresent: true,
      whisperBinPath: "/whisper-cli",
      whisperModelPath: "/model.bin",
      codesignIdentityPresent: true,
      launchAtLogin: true,
      launchAtLoginOpenAtLogin: true,
      exists: () => true
    });

    expect(ids(summary)["launch-at-login"]).toBe("ok");
    expect(summary.counts.warn).toBe(0);
  });
});

// #174: a permanent warn about a permission Marshal never requests itself.
describe("microphone in setup health", () => {
  const base = {
    platform: "darwin" as NodeJS.Platform,
    dictationEnabled: true,
    dictationBackend: "hybrid" as const,
    screenStatus: "granted" as const,
    accessibilityTrusted: true,
    apiKeyPresent: true,
    whisperBinPath: "/whisper-cli",
    whisperModelPath: "/model.bin",
    codesignIdentityPresent: true,
    launchAtLogin: false,
    exists: () => true
  };

  const micItem = (microphoneStatus: "granted" | "denied" | "not-determined") =>
    buildSetupHealth({ ...base, microphoneStatus }).items.find((i) => i.id === "microphone");

  it("reports not-determined as unknown, not as something to go fix", () => {
    const item = micItem("not-determined");
    expect(item?.status).toBe("unknown");
    // No action: sending the user to System Settings would be a dead end, the
    // grant they need is already there under the helper's name.
    expect(item?.action).toBeUndefined();
    expect(item?.detail).toMatch(/audio-recorder/u);
  });

  it("still reports an actual refusal as an error with an action", () => {
    const item = micItem("denied");
    expect(item?.status).toBe("error");
    expect(item?.action).toMatch(/System Settings/u);
  });

  it("reports a real grant as ok", () => {
    expect(micItem("granted")?.status).toBe("ok");
  });
});
