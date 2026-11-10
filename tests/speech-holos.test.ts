import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  HOLOS_REQUIREMENTS,
  HOLOS_REVISION,
  HOLOS_SERVER_SCRIPT,
  holosEnv,
  holosPaths,
  holosSpeedForRate,
  isHolosInstalled,
  listHolosVoices,
  resolveHolosVoice,
  voiceNameFromFile
} from "../desktop/speech/holos.ts";
import { chooseSpeechEngine, normalizeSpeechEngine } from "../desktop/speech/speech-policy.ts";

function installedRoot(voices: string[], custom: string[] = []): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "holos-test-"));
  const paths = holosPaths(root);
  mkdirSync(path.dirname(paths.python), { recursive: true });
  writeFileSync(paths.python, "");
  writeFileSync(paths.script, HOLOS_SERVER_SCRIPT);
  writeFileSync(paths.manifest, JSON.stringify({ revision: HOLOS_REVISION, voices }));
  mkdirSync(paths.voicesDir, { recursive: true });
  for (const name of custom) writeFileSync(path.join(paths.voicesDir, `${name}.npy`), "");
  return root;
}

describe("Holos engine choice", () => {
  it("speaks Ukrainian through Holos once installed, English stays on say", () => {
    expect(chooseSpeechEngine("holos", "uk", true)).toBe("holos");
    expect(chooseSpeechEngine("holos", "en", true)).toBe("macos");
    expect(chooseSpeechEngine("holos", "uk", false)).toBe("macos");
  });

  it("keeps holos as a stored engine", () => {
    expect(normalizeSpeechEngine("holos")).toBe("holos");
  });
});

describe("Holos install state and voices", () => {
  it("counts as installed only with the manifest written last", () => {
    const root = installedRoot(["Speaker_0"]);
    expect(isHolosInstalled(holosPaths(root))).toBe(true);
    expect(isHolosInstalled(holosPaths(path.join(root, "missing")))).toBe(false);
  });

  it("lists presets from the manifest and cloned voices from voices/", () => {
    const root = installedRoot(["Speaker_0", "Гаська Шиян"], ["Анастасія", "alpha"]);
    expect(listHolosVoices(holosPaths(root))).toEqual({
      presets: ["Speaker_0", "Гаська Шиян"],
      custom: ["alpha", "Анастасія"]
    });
  });

  it("passes a cloned voice as its .npy path and a preset by name", () => {
    const root = installedRoot(["Speaker_0"], ["Анастасія"]);
    const paths = holosPaths(root);
    expect(resolveHolosVoice("Анастасія", paths)).toBe(path.join(paths.voicesDir, "Анастасія.npy"));
    expect(resolveHolosVoice("Speaker_0", paths)).toBe("Speaker_0");
    expect(resolveHolosVoice("  ", paths)).toBe("");
  });

  it("never resolves a voice name outside voices/", () => {
    const root = installedRoot([], []);
    const paths = holosPaths(root);
    writeFileSync(path.join(root, "secret.npy"), "");
    expect(resolveHolosVoice("../secret", paths)).toBe("../secret");
  });
});

describe("Holos helpers", () => {
  it("turns a recording file name into a safe voice name", () => {
    expect(voiceNameFromFile("/x/styletts2-anastasiia-pavlenko.wav")).toBe("styletts2-anastasiia-pavlenko");
    expect(voiceNameFromFile("/x/Анастасія (чисто).m4a")).toBe("Анастасія чисто");
    expect(voiceNameFromFile("/x/../.wav")).toBe("voice");
  });

  it("maps the say rate to Holos speed (faster = larger)", () => {
    expect(holosSpeedForRate(190)).toBe(1);
    expect(holosSpeedForRate(285)).toBe(1.5);
    expect(holosSpeedForRate("junk")).toBe(1);
  });

  it("runs offline with every cache inside the install dir", () => {
    const paths = holosPaths("/m/holos");
    const env = holosEnv(paths, true);
    expect(env.HF_HOME).toBe("/m/holos/hf");
    expect(env.STANZA_RESOURCES_DIR).toBe("/m/holos/stanza");
    expect(env.HF_HUB_OFFLINE).toBe("1");
    expect(holosEnv(paths, false).HF_HUB_OFFLINE).toBeUndefined();
  });

  it("pins the frontend to commits and the model to a revision", () => {
    const frontend = HOLOS_REQUIREMENTS.filter((req) => req.includes("github.com"));
    expect(frontend).toHaveLength(2);
    for (const line of frontend) expect(line).toMatch(/\/archive\/[0-9a-f]{40}\.tar\.gz$/);
    expect(HOLOS_SERVER_SCRIPT).toContain(`REVISION = "${HOLOS_REVISION}"`);
  });
});
