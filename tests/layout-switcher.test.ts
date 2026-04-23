import { describe, it, expect } from "vitest";

import { transliterate } from "../desktop/translator/layout-switcher.ts";

describe("transliterate", () => {
  it("converts latin typed-by-mistake into ЙЦУКЕН Ukrainian", () => {
    expect(transliterate("ghbdsn").text).toBe("привіт");
    expect(transliterate("ghbdsn").direction).toBe("eng-to-ukr");
  });

  it("converts Ukrainian typed-by-mistake into latin", () => {
    expect(transliterate("привіт").text).toBe("ghbdsn");
    expect(transliterate("привіт").direction).toBe("ukr-to-eng");
  });

  it("is symmetric for known keys", () => {
    const samples = ["hello world", "typescript", "react native", "cmd shift"];
    for (const s of samples) {
      const forward = transliterate(s).text;
      const back = transliterate(forward).text;
      expect(back).toBe(s);
    }
  });

  it("preserves digits, spaces, and unmapped punctuation", () => {
    expect(transliterate("ghbdsn 2026!").text).toBe("привіт 2026!");
  });

  it("preserves case", () => {
    expect(transliterate("Ghbdsn").text).toBe("Привіт");
    expect(transliterate("GHBDSN").text).toBe("ПРИВІТ");
  });

  it("returns input unchanged when there are no letters", () => {
    const result = transliterate("123 / 456");
    expect(result.text).toBe("123 / 456");
    expect(result.direction).toBe("none");
  });

  it("returns input unchanged on empty string", () => {
    expect(transliterate("").text).toBe("");
    expect(transliterate("").direction).toBe("none");
  });

  it("detects direction from the first letter when text is mixed", () => {
    // Starts with cyrillic → treat as ukr-to-eng; trailing latin stays as-is.
    const r = transliterate("привіт abc");
    expect(r.direction).toBe("ukr-to-eng");
    expect(r.text.startsWith("ghbdsn")).toBe(true);
  });

  it("maps shifted punctuation when a letter anchors the direction", () => {
    // ";" on ENG maps to "ж" on UKR, but direction detection needs a letter.
    expect(transliterate("h;").text).toBe("рж");
    expect(transliterate("рж").text).toBe("h;");
  });
});
