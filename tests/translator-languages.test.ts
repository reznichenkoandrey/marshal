import { describe, expect, it } from "vitest";

import {
  LANGUAGES,
  detectScriptLang,
  isLangCode,
  isSourceLang,
  languageName,
  languageNative,
  resolveLangCode,
  resolveSourceLang
} from "../desktop/translator/languages.ts";

describe("language registry", () => {
  it("has no duplicate codes", () => {
    const codes = LANGUAGES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("carries a name and an endonym for every entry", () => {
    for (const entry of LANGUAGES) {
      expect(entry.code).toMatch(/^[a-z]{2}$/u);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.native.length).toBeGreaterThan(0);
    }
  });

  it("stays sorted by English name so the picker needs no sort", () => {
    const names = LANGUAGES.map((entry) => entry.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("keeps the app's own pair available", () => {
    expect(isLangCode("uk")).toBe(true);
    expect(isLangCode("en")).toBe(true);
  });
});

describe("isLangCode / isSourceLang", () => {
  it("rejects unknown and non-string input", () => {
    expect(isLangCode("xx")).toBe(false);
    expect(isLangCode("")).toBe(false);
    expect(isLangCode(undefined)).toBe(false);
    expect(isLangCode(42)).toBe(false);
  });

  it("accepts auto only on the source side", () => {
    expect(isSourceLang("auto")).toBe(true);
    expect(isLangCode("auto")).toBe(false);
  });
});

describe("resolveLangCode", () => {
  it("passes through a known code", () => {
    expect(resolveLangCode("de", "uk")).toBe("de");
  });

  it("takes the primary subtag of a locale", () => {
    expect(resolveLangCode("en-GB", "uk")).toBe("en");
    expect(resolveLangCode("ZH_Hans", "uk")).toBe("zh");
    expect(resolveLangCode("nb-NO", "uk")).toBe("nb");
  });

  it("falls back on unknown, empty and non-string input", () => {
    expect(resolveLangCode("klingon", "uk")).toBe("uk");
    expect(resolveLangCode("", "en")).toBe("en");
    expect(resolveLangCode(undefined, "en")).toBe("en");
    expect(resolveLangCode(null, "uk")).toBe("uk");
  });
});

describe("resolveSourceLang", () => {
  it("keeps auto", () => {
    expect(resolveSourceLang("auto", "uk")).toBe("auto");
    expect(resolveSourceLang("AUTO", "uk")).toBe("auto");
  });

  it("resolves concrete codes and locales", () => {
    expect(resolveSourceLang("pl", "auto")).toBe("pl");
    expect(resolveSourceLang("pt-BR", "auto")).toBe("pt");
  });

  it("falls back on garbage", () => {
    expect(resolveSourceLang("nope", "auto")).toBe("auto");
    expect(resolveSourceLang("", "uk")).toBe("uk");
    expect(resolveSourceLang(undefined, "en")).toBe("en");
  });
});

describe("detectScriptLang", () => {
  it("names the script it can see", () => {
    expect(detectScriptLang("Привіт, як справи?")).toBe("uk");
    expect(detectScriptLang("Καλημέρα")).toBe("el");
    expect(detectScriptLang("שלום")).toBe("he");
    expect(detectScriptLang("مرحبا")).toBe("ar");
    expect(detectScriptLang("नमस्ते")).toBe("hi");
    expect(detectScriptLang("สวัสดี")).toBe("th");
    expect(detectScriptLang("გამარჯობა")).toBe("ka");
    expect(detectScriptLang("こんにちは")).toBe("ja");
    expect(detectScriptLang("안녕하세요")).toBe("ko");
    expect(detectScriptLang("你好世界")).toBe("zh");
  });

  it("collapses every Latin-script language into en", () => {
    expect(detectScriptLang("Hello world")).toBe("en");
    expect(detectScriptLang("Ordnung muss sein")).toBe("en");
    expect(detectScriptLang("123 ???")).toBe("en");
  });

  it("prefers the non-Latin script in mixed text", () => {
    expect(detectScriptLang("Hello, світ")).toBe("uk");
  });
});

describe("languageName / languageNative", () => {
  it("resolves known codes", () => {
    expect(languageName("uk")).toBe("Ukrainian");
    expect(languageNative("uk")).toBe("Українська");
  });

  it("falls back to the uppercased code so prompts never say undefined", () => {
    expect(languageName("xx")).toBe("XX");
    expect(languageNative("xx")).toBe("XX");
  });
});
