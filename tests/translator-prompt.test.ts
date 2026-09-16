import { describe, expect, it } from "vitest";

import {
  buildOcrTranslatePrompt,
  buildTranslateJsonPrompt,
  ocrSourceLang,
  resolveSourceLang,
  targetLangName
} from "../desktop/translator/backends/shared.ts";

describe("buildTranslateJsonPrompt", () => {
  it("names the target language in full, not as a code", () => {
    const prompt = buildTranslateJsonPrompt("Hello", "uk");
    expect(prompt).toContain("Translate the user text to Ukrainian");
    expect(prompt).not.toContain("to uk");
  });

  it("works for any registry language, not just uk/en", () => {
    expect(buildTranslateJsonPrompt("Hello", "ja")).toContain("Japanese");
    expect(buildTranslateJsonPrompt("Hello", "pt")).toContain("Portuguese");
  });

  it("states the source language only when the user picked one", () => {
    expect(buildTranslateJsonPrompt("Hallo", "uk", { sourceLang: "de" }))
      .toContain("The source text is in German.");
    expect(buildTranslateJsonPrompt("Hallo", "uk", { sourceLang: "auto" }))
      .not.toContain("source text is in");
    expect(buildTranslateJsonPrompt("Hallo", "uk")).not.toContain("source text is in");
  });

  it("adds a register instruction only for formal/informal", () => {
    expect(buildTranslateJsonPrompt("Hi", "uk", { formality: "formal" })).toContain("formal register");
    expect(buildTranslateJsonPrompt("Hi", "uk", { formality: "informal" })).toContain("informal register");
    expect(buildTranslateJsonPrompt("Hi", "uk", { formality: "default" })).not.toContain("register");
  });

  it("keeps the JSON contract and the source text", () => {
    const prompt = buildTranslateJsonPrompt("line one\nline two", "en");
    expect(prompt).toContain('{"sourceLang":"<ISO 639-1 code>","translation":"<translated text>"}');
    expect(prompt).toContain("line one\nline two");
  });
});

describe("buildOcrTranslatePrompt", () => {
  it("asks for plain text, never JSON", () => {
    const prompt = buildOcrTranslatePrompt("uk");
    expect(prompt).toContain("Ukrainian");
    expect(prompt).toContain("no JSON");
  });

  it("honours source and formality", () => {
    const prompt = buildOcrTranslatePrompt("en", { sourceLang: "pl", formality: "formal" });
    expect(prompt).toContain("The source text is in Polish.");
    expect(prompt).toContain("formal register");
  });
});

describe("resolveSourceLang", () => {
  it("prefers an explicit choice over what the model reported", () => {
    expect(resolveSourceLang("Hallo", "en", { sourceLang: "de" })).toBe("de");
  });

  it("uses the model's answer when the source is on auto", () => {
    expect(resolveSourceLang("Hallo", "de", { sourceLang: "auto" })).toBe("de");
  });

  it("falls back to the script when nothing was reported", () => {
    expect(resolveSourceLang("Привіт", "", undefined)).toBe("uk");
    expect(resolveSourceLang("你好", "", { sourceLang: "auto" })).toBe("zh");
    expect(resolveSourceLang("Hello", "", undefined)).toBe("en");
  });
});

describe("ocrSourceLang", () => {
  it("reports auto unless the user pinned a source", () => {
    expect(ocrSourceLang(undefined)).toBe("auto");
    expect(ocrSourceLang({ sourceLang: "auto" })).toBe("auto");
    expect(ocrSourceLang({ sourceLang: "ja" })).toBe("ja");
  });
});

describe("targetLangName", () => {
  it("still resolves the historical uk/en pair", () => {
    expect(targetLangName("uk")).toBe("Ukrainian");
    expect(targetLangName("en")).toBe("English");
  });
});
