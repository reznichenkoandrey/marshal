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
      codesign: "ok"
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
});
