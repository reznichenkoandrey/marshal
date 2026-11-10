import { describe, expect, it } from "vitest";

import { buildPiperArgs, lengthScaleForRate, piperPaths, PIPER_ARCHIVES } from "../desktop/speech/piper.ts";
import { chooseSpeechEngine, normalizeSpeechEngine } from "../desktop/speech/speech-policy.ts";

describe("chooseSpeechEngine", () => {
  it("uses Piper only for Ukrainian with the voice downloaded", () => {
    expect(chooseSpeechEngine("piper", "uk", true)).toBe("piper");
  });

  it("keeps English on say: Piper has no English voice", () => {
    expect(chooseSpeechEngine("piper", "en", true)).toBe("macos");
  });

  it("falls back to say while Piper is not downloaded", () => {
    expect(chooseSpeechEngine("piper", "uk", false)).toBe("macos");
  });

  it("never picks Piper when macOS is selected", () => {
    expect(chooseSpeechEngine("macos", "uk", true)).toBe("macos");
  });

  it("normalizes unknown stored values to macOS", () => {
    expect(normalizeSpeechEngine("piper")).toBe("piper");
    expect(normalizeSpeechEngine("kokoro")).toBe("macos");
    expect(normalizeSpeechEngine(undefined)).toBe("macos");
  });
});

describe("buildPiperArgs", () => {
  const paths = piperPaths("/models/piper");

  it("points the CLI at the lada voice with espeak-ng data", () => {
    const args = buildPiperArgs(paths, "Привіт", "/tmp/out.wav", 190);
    expect(args).toEqual([
      "--vits-model=/models/piper/vits-piper-uk_UA-lada-x_low-int8/uk_UA-lada-x_low.onnx",
      "--vits-tokens=/models/piper/vits-piper-uk_UA-lada-x_low-int8/tokens.txt",
      "--vits-data-dir=/models/piper/vits-piper-uk_UA-lada-x_low-int8/espeak-ng-data",
      "--vits-length-scale=1",
      "--num-threads=2",
      "--output-filename=/tmp/out.wav",
      "--",
      "Привіт"
    ]);
    expect(paths.binary).toBe("/models/piper/sherpa-onnx-v1.13.8-osx-arm64-shared/bin/sherpa-onnx-offline-tts");
  });

  it("keeps text that looks like a flag after the -- separator", () => {
    const args = buildPiperArgs(paths, "--sid=1 привіт", "/tmp/out.wav", 190);
    expect(args.slice(-2)).toEqual(["--", "--sid=1 привіт"]);
  });

  it("maps the say rate to a length scale (faster = shorter)", () => {
    expect(lengthScaleForRate(190)).toBe(1);
    expect(lengthScaleForRate(380)).toBe(0.53); // clamped to 360 wpm
    expect(lengthScaleForRate(95)).toBe(2);
    expect(lengthScaleForRate("junk")).toBe(1);
  });

  it("unpacks only the TTS CLI and its dylibs from the runtime archive", () => {
    expect(PIPER_ARCHIVES[0].members).toEqual([
      "sherpa-onnx-v1.13.8-osx-arm64-shared/bin/sherpa-onnx-offline-tts",
      "sherpa-onnx-v1.13.8-osx-arm64-shared/lib"
    ]);
  });
});
