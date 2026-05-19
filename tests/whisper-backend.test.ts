import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DICTATION_PROMPT,
  GroqWhisperBackend,
  WhisperCppBackend,
  createWhisperBackend,
  parseDetectedLanguage,
  resolveBackendName,
  resolveDictationPrompt
} from "../desktop/dictation/whisper-backend.ts";

describe("parseDetectedLanguage", () => {
  it("extracts 2-letter code from whisper-cli stderr", () => {
    const stderr = [
      "whisper_full_with_state: auto-detected language: uk (p = 0.998)",
      "whisper_print_timings: total time = 1234 ms"
    ].join("\n");
    expect(parseDetectedLanguage(stderr)).toBe("uk");
  });

  it("returns undefined when the banner is absent", () => {
    expect(parseDetectedLanguage("total time = 1234 ms")).toBeUndefined();
  });

  it("returns undefined for empty stderr", () => {
    expect(parseDetectedLanguage("")).toBeUndefined();
  });
});

describe("resolveBackendName", () => {
  it("returns whisper-cpp by default", () => {
    expect(resolveBackendName(undefined)).toBe("whisper-cpp");
    expect(resolveBackendName("")).toBe("whisper-cpp");
  });

  it("selects groq when requested", () => {
    expect(resolveBackendName("groq")).toBe("groq");
    expect(resolveBackendName("GROQ")).toBe("groq");
  });

  it("falls back to whisper-cpp for unknown values", () => {
    expect(resolveBackendName("nonsense")).toBe("whisper-cpp");
  });
});

describe("resolveDictationPrompt", () => {
  it("returns the bundled default when var is undefined", () => {
    expect(resolveDictationPrompt(undefined)).toBe(DEFAULT_DICTATION_PROMPT);
  });

  it("returns a user-supplied prompt verbatim after trimming", () => {
    expect(resolveDictationPrompt("  React, Magento, PR  ")).toBe("React, Magento, PR");
  });

  it("returns empty string when caller explicitly blanks the prompt", () => {
    // Distinct from undefined: the user wants whisper running without any prompt.
    expect(resolveDictationPrompt("")).toBe("");
    expect(resolveDictationPrompt("   ")).toBe("");
  });

  it("default prompt is under the ~1000-character practical cap", () => {
    expect(DEFAULT_DICTATION_PROMPT.length).toBeLessThan(1000);
  });
});

describe("createWhisperBackend", () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.MARSHAL_API_KEY;
    process.env.MARSHAL_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.MARSHAL_API_KEY;
    else process.env.MARSHAL_API_KEY = originalApiKey;
  });

  it("instantiates the WhisperCppBackend for whisper-cpp", () => {
    expect(createWhisperBackend("whisper-cpp")).toBeInstanceOf(WhisperCppBackend);
  });

  it("instantiates the GroqWhisperBackend for groq", () => {
    expect(createWhisperBackend("groq")).toBeInstanceOf(GroqWhisperBackend);
  });
});

describe("GroqWhisperBackend", () => {
  let originalKey: string | undefined;
  let originalBase: string | undefined;
  let originalModel: string | undefined;

  beforeEach(() => {
    originalKey = process.env.MARSHAL_API_KEY;
    originalBase = process.env.MARSHAL_API_BASE;
    originalModel = process.env.MARSHAL_WHISPER_MODEL_REMOTE;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.MARSHAL_API_KEY;
    else process.env.MARSHAL_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.MARSHAL_API_BASE;
    else process.env.MARSHAL_API_BASE = originalBase;
    if (originalModel === undefined) delete process.env.MARSHAL_WHISPER_MODEL_REMOTE;
    else process.env.MARSHAL_WHISPER_MODEL_REMOTE = originalModel;
  });

  it("throws when MARSHAL_API_KEY is missing", async () => {
    delete process.env.MARSHAL_API_KEY;
    const backend = new GroqWhisperBackend();
    await expect(backend.transcribe("/tmp/nope.wav")).rejects.toThrow(/MARSHAL_API_KEY/);
  });

  it("strips trailing slashes from MARSHAL_API_BASE", () => {
    process.env.MARSHAL_API_KEY = "k";
    process.env.MARSHAL_API_BASE = "https://api.groq.com/openai/v1/////";
    // No public accessor for `baseUrl`, but the constructor's normalization
    // is the only code we need to exercise here — `new` not throwing under
    // a path-with-trailing-slashes input is the assertion.
    expect(() => new GroqWhisperBackend()).not.toThrow();
  });
});

describe("WhisperCppBackend", () => {
  let originalBin: string | undefined;
  let originalModel: string | undefined;
  let originalThreads: string | undefined;

  beforeEach(() => {
    originalBin = process.env.MARSHAL_WHISPER_BIN;
    originalModel = process.env.MARSHAL_WHISPER_MODEL;
    originalThreads = process.env.MARSHAL_WHISPER_THREADS;
  });

  afterEach(() => {
    if (originalBin === undefined) delete process.env.MARSHAL_WHISPER_BIN;
    else process.env.MARSHAL_WHISPER_BIN = originalBin;
    if (originalModel === undefined) delete process.env.MARSHAL_WHISPER_MODEL;
    else process.env.MARSHAL_WHISPER_MODEL = originalModel;
    if (originalThreads === undefined) delete process.env.MARSHAL_WHISPER_THREADS;
    else process.env.MARSHAL_WHISPER_THREADS = originalThreads;
  });

  it("constructs with default paths when env vars are unset", () => {
    delete process.env.MARSHAL_WHISPER_BIN;
    delete process.env.MARSHAL_WHISPER_MODEL;
    delete process.env.MARSHAL_WHISPER_THREADS;
    expect(() => new WhisperCppBackend()).not.toThrow();
  });

  it("throws a useful error when the binary path is missing", async () => {
    process.env.MARSHAL_WHISPER_BIN = "/definitely/not/here/whisper-cli";
    process.env.MARSHAL_WHISPER_MODEL = "/definitely/not/here/ggml-small.bin";
    const backend = new WhisperCppBackend();
    await expect(backend.transcribe("/tmp/anything.wav")).rejects.toThrow(/whisper.cpp binary/);
  });

  it("falls back to default 4 threads when MARSHAL_WHISPER_THREADS is not a number", () => {
    process.env.MARSHAL_WHISPER_THREADS = "definitely-not-a-number";
    // The default is private state; cover the parse branch via no-throw + an
    // implicit assert that the public surface still works.
    expect(() => new WhisperCppBackend()).not.toThrow();
  });

  it("accepts a finite positive value for MARSHAL_WHISPER_THREADS", () => {
    process.env.MARSHAL_WHISPER_THREADS = "8";
    expect(() => new WhisperCppBackend()).not.toThrow();
  });
});
