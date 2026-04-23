import { describe, expect, it } from "vitest";

import {
  DEFAULT_DICTATION_PROMPT,
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
