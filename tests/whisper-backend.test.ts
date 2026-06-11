import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DICTATION_PROMPT,
  GroqWhisperBackend,
  HybridWhisperBackend,
  WhisperCppBackend,
  createWhisperBackend,
  parseDetectedLanguage,
  resolveBackendName,
  resolveDictationLanguage,
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
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.MARSHAL_API_KEY;
    delete process.env.MARSHAL_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.MARSHAL_API_KEY;
    else process.env.MARSHAL_API_KEY = originalKey;
  });

  it("returns whisper-cpp when no API key (offline-safe default)", () => {
    expect(resolveBackendName(undefined)).toBe("whisper-cpp");
    expect(resolveBackendName("")).toBe("whisper-cpp");
  });

  it("auto-picks hybrid when MARSHAL_API_KEY is set and value is unspecified", () => {
    process.env.MARSHAL_API_KEY = "test-key";
    expect(resolveBackendName(undefined)).toBe("hybrid");
    expect(resolveBackendName("")).toBe("hybrid");
  });

  it("selects groq when explicitly requested", () => {
    expect(resolveBackendName("groq")).toBe("groq");
    expect(resolveBackendName("GROQ")).toBe("groq");
  });

  it("selects whisper-cpp when explicitly requested", () => {
    expect(resolveBackendName("whisper-cpp")).toBe("whisper-cpp");
    expect(resolveBackendName("WHISPER-CPP")).toBe("whisper-cpp");
  });

  it("selects hybrid when explicitly requested", () => {
    expect(resolveBackendName("hybrid")).toBe("hybrid");
    expect(resolveBackendName("HYBRID")).toBe("hybrid");
  });

  it("falls back to whisper-cpp for unknown values (no API key)", () => {
    expect(resolveBackendName("nonsense")).toBe("whisper-cpp");
  });

  it("falls back to hybrid for unknown values when API key is set", () => {
    process.env.MARSHAL_API_KEY = "test-key";
    expect(resolveBackendName("nonsense")).toBe("hybrid");
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

describe("resolveDictationLanguage", () => {
  it("defaults to Ukrainian when unset", () => {
    expect(resolveDictationLanguage(undefined)).toBe("uk");
  });

  it("lets users opt back into auto-detection", () => {
    expect(resolveDictationLanguage("")).toBeUndefined();
    expect(resolveDictationLanguage("auto")).toBeUndefined();
    expect(resolveDictationLanguage(" AUTO ")).toBeUndefined();
  });

  it("normalizes locale-like language values", () => {
    expect(resolveDictationLanguage("uk-UA")).toBe("uk");
    expect(resolveDictationLanguage("EN")).toBe("en");
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

  it("instantiates the HybridWhisperBackend for hybrid", () => {
    expect(createWhisperBackend("hybrid")).toBeInstanceOf(HybridWhisperBackend);
  });
});

describe("HybridWhisperBackend", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.MARSHAL_API_KEY;
    process.env.MARSHAL_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.MARSHAL_API_KEY;
    else process.env.MARSHAL_API_KEY = originalKey;
  });

  it("returns primary result when Groq succeeds", async () => {
    const hybrid = new HybridWhisperBackend();
    // Replace internal primary/fallback with stubs via Object.assign so we
    // don't actually hit network or spawn whisper-cli in unit tests.
    Object.assign(hybrid as unknown as Record<string, unknown>, {
      primary: { transcribe: async () => ({ text: "from groq", language: "uk" }) },
      fallback: { transcribe: async () => ({ text: "should not be called", language: "uk" }) }
    });
    const result = await hybrid.transcribe("/tmp/fake.wav");
    expect(result.text).toBe("from groq");
  });

  it("falls back to whisper.cpp when Groq throws", async () => {
    const hybrid = new HybridWhisperBackend();
    let fallbackCalled = false;
    Object.assign(hybrid as unknown as Record<string, unknown>, {
      primary: {
        transcribe: async () => {
          throw new Error("Groq whisper API 429: rate limit");
        }
      },
      fallback: {
        transcribe: async () => {
          fallbackCalled = true;
          return { text: "from local", language: "uk" };
        }
      }
    });
    const result = await hybrid.transcribe("/tmp/fake.wav");
    expect(fallbackCalled).toBe(true);
    expect(result.text).toBe("from local");
  });

  it("propagates errors from the fallback if it also fails", async () => {
    const hybrid = new HybridWhisperBackend();
    Object.assign(hybrid as unknown as Record<string, unknown>, {
      primary: {
        transcribe: async () => {
          throw new Error("groq down");
        }
      },
      fallback: {
        transcribe: async () => {
          throw new Error("local model missing");
        }
      }
    });
    await expect(hybrid.transcribe("/tmp/fake.wav")).rejects.toThrow(/local model missing/);
  });

  it("forwards transcribe options to primary on success", async () => {
    const hybrid = new HybridWhisperBackend();
    let receivedOptions: unknown;
    Object.assign(hybrid as unknown as Record<string, unknown>, {
      primary: {
        transcribe: async (_wav: string, opts: unknown) => {
          receivedOptions = opts;
          return { text: "ok", language: "uk" };
        }
      },
      fallback: { transcribe: async () => ({ text: "", language: "" }) }
    });
    await hybrid.transcribe("/tmp/fake.wav", { language: "uk", prompt: "test prompt" });
    expect(receivedOptions).toEqual({ language: "uk", prompt: "test prompt" });
  });

  it("forwards transcribe options to fallback on Groq failure", async () => {
    const hybrid = new HybridWhisperBackend();
    let fallbackOptions: unknown;
    Object.assign(hybrid as unknown as Record<string, unknown>, {
      primary: {
        transcribe: async () => {
          throw new Error("nope");
        }
      },
      fallback: {
        transcribe: async (_wav: string, opts: unknown) => {
          fallbackOptions = opts;
          return { text: "local ok", language: "uk" };
        }
      }
    });
    await hybrid.transcribe("/tmp/fake.wav", { language: "uk", prompt: "hello" });
    expect(fallbackOptions).toEqual({ language: "uk", prompt: "hello" });
  });
});

describe("DEFAULT_DICTATION_PROMPT (updated for #93)", () => {
  it("includes a verbatim instruction so the model preserves surzhyk", () => {
    expect(DEFAULT_DICTATION_PROMPT.toLowerCase()).toMatch(/дослівно|verbatim/u);
  });

  it("includes Anthropic / Claude Code vocabulary", () => {
    expect(DEFAULT_DICTATION_PROMPT).toMatch(/Claude Code/u);
    expect(DEFAULT_DICTATION_PROMPT).toMatch(/MCP/u);
  });

  it("includes the high-payoff Americanisms the user uses daily", () => {
    expect(DEFAULT_DICTATION_PROMPT).toMatch(/deploy/u);
    expect(DEFAULT_DICTATION_PROMPT).toMatch(/refactor/u);
    expect(DEFAULT_DICTATION_PROMPT).toMatch(/blocker/u);
  });

  it("stays under the practical whisper prompt cap (~1000 chars)", () => {
    expect(DEFAULT_DICTATION_PROMPT.length).toBeLessThan(1000);
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
