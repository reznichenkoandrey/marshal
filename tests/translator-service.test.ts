import { describe, expect, it } from "vitest";

import {
  detectLangHeuristic,
  extractBracedJson,
  parseFloatEnv,
  parseIntEnv,
  parseRetryAfterMs,
  parseTranslateJson,
  stripCodeFence
} from "../desktop/translator/translator-service.ts";

describe("detectLangHeuristic", () => {
  it("returns uk for Cyrillic text", () => {
    expect(detectLangHeuristic("Привіт, як справи?")).toBe("uk");
    expect(detectLangHeuristic("Мій код працює")).toBe("uk");
    expect(detectLangHeuristic("русский текст")).toBe("uk");
  });

  it("returns en for Latin text", () => {
    expect(detectLangHeuristic("Hello world")).toBe("en");
    expect(detectLangHeuristic("Ordnung muss sein")).toBe("en");
    expect(detectLangHeuristic("123 ???")).toBe("en");
  });

  it("returns uk when the text mixes Latin and Cyrillic", () => {
    expect(detectLangHeuristic("Hello, світ")).toBe("uk");
  });
});

describe("parseTranslateJson", () => {
  it("parses a plain JSON response", () => {
    const raw = '{"sourceLang":"en","translation":"Привіт"}';
    expect(parseTranslateJson(raw)).toEqual({ sourceLang: "en", translation: "Привіт" });
  });

  it("strips markdown code fences", () => {
    const raw = '```json\n{"sourceLang":"en","translation":"Hello"}\n```';
    expect(parseTranslateJson(raw)).toEqual({ sourceLang: "en", translation: "Hello" });
  });

  it("extracts JSON embedded in commentary", () => {
    const raw = 'Sure! Here is the result: {"sourceLang":"UK","translation":"Hi"} — enjoy!';
    expect(parseTranslateJson(raw)).toEqual({ sourceLang: "uk", translation: "Hi" });
  });

  it("lowercases and trims sourceLang to 2 chars", () => {
    const raw = '{"sourceLang":"EN-us","translation":"Привіт"}';
    expect(parseTranslateJson(raw).sourceLang).toBe("en");
  });

  it("falls back to raw text when no JSON parses", () => {
    expect(parseTranslateJson("just plain text")).toEqual({
      sourceLang: "",
      translation: "just plain text"
    });
  });

  it("ignores a JSON object with an empty translation field", () => {
    const raw = '{"sourceLang":"en","translation":""}';
    // Empty translation → parser keeps looking; fallback returns raw.
    expect(parseTranslateJson(raw).translation).toBe(raw);
  });
});

describe("stripCodeFence", () => {
  it("strips ```json fences", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips bare ``` fences", () => {
    expect(stripCodeFence('```\nhello\n```')).toBe('hello');
  });

  it("returns empty string when no fence is present", () => {
    expect(stripCodeFence('{"a":1}')).toBe('');
  });
});

describe("extractBracedJson", () => {
  it("extracts the outermost braced region", () => {
    expect(extractBracedJson('prefix {"a":1,"b":{"c":2}} suffix')).toBe('{"a":1,"b":{"c":2}}');
  });

  it("returns empty string when no braces", () => {
    expect(extractBracedJson("no braces here")).toBe("");
  });

  it("returns empty when closing brace precedes opening", () => {
    expect(extractBracedJson("} first closing")).toBe("");
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("0.5")).toBe(500);
  });

  it("clamps to 30s", () => {
    expect(parseRetryAfterMs("9999")).toBe(30_000);
  });

  it("parses HTTP-date", () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(0);
    expect(ms!).toBeLessThanOrEqual(30_000);
  });

  it("returns null for null/invalid values", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("nonsense")).toBeNull();
  });
});

describe("parseFloatEnv / parseIntEnv", () => {
  const KEY = "MARSHAL_TEST_NUM_ENV";

  it("returns fallback when var is unset", () => {
    delete process.env[KEY];
    expect(parseFloatEnv(KEY, 0.5)).toBe(0.5);
    expect(parseIntEnv(KEY, 42)).toBe(42);
  });

  it("returns fallback when var is non-numeric", () => {
    process.env[KEY] = "abc";
    expect(parseFloatEnv(KEY, 1)).toBe(1);
    expect(parseIntEnv(KEY, 1)).toBe(1);
    delete process.env[KEY];
  });

  it("parses valid numeric values", () => {
    process.env[KEY] = "3.14";
    expect(parseFloatEnv(KEY, 0)).toBeCloseTo(3.14);
    process.env[KEY] = "7";
    expect(parseIntEnv(KEY, 0)).toBe(7);
    delete process.env[KEY];
  });

  it("parseIntEnv rejects zero and negative", () => {
    process.env[KEY] = "0";
    expect(parseIntEnv(KEY, 10)).toBe(10);
    process.env[KEY] = "-5";
    expect(parseIntEnv(KEY, 10)).toBe(10);
    delete process.env[KEY];
  });
});
