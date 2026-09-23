// tests/translator-alternatives.test.ts
//
// Covers the pure halves of click-a-word alternatives (#146): the renderer's
// tokenizer / sentence finder / applier, and the main process's prompt and
// JSON parser.
//
// The rules pinned here are the ones a wrong answer would corrupt silently:
// tokens must cover the text exactly (otherwise the rendered pane differs from
// the translation it claims to show), the sentence range must not swallow a
// neighbouring line, and a parsed alternative without a rewritten sentence
// must never reach the popover — picking it would replace a sentence with
// nothing.

import { describe, expect, it } from "vitest";

import {
  alternativesCacheKey,
  applyAlternative,
  sentenceRangeAt,
  tokenizeTranslation
} from "../desktop/renderer/translator-alternatives.js";
import {
  MAX_ALTERNATIVES,
  buildAlternativesPrompt,
  clampAlternativesRequest,
  parseAlternativesJson
} from "../desktop/translator/backends/alternatives.ts";

describe("tokenizeTranslation", () => {
  it("covers the input exactly", () => {
    const text = "Привіт, світе!\nДругий рядок — тире.";
    const tokens = tokenizeTranslation(text);
    expect(tokens.map((t) => t.text).join("")).toBe(text);
    for (const token of tokens) {
      expect(text.slice(token.start, token.end)).toBe(token.text);
    }
  });

  it("keeps apostrophes and hyphens inside a word", () => {
    const words = tokenizeTranslation("don't well-known зв'язок").filter((t) => t.isWord);
    expect(words.map((t) => t.text)).toEqual(["don't", "well-known", "зв'язок"]);
  });

  it("treats digits as words and punctuation as separators", () => {
    const tokens = tokenizeTranslation("v2 — 300 ms");
    expect(tokens.filter((t) => t.isWord).map((t) => t.text)).toEqual(["v2", "300", "ms"]);
  });

  it("returns nothing for empty input", () => {
    expect(tokenizeTranslation("")).toEqual([]);
    expect(tokenizeTranslation(null as unknown as string)).toEqual([]);
  });
});

describe("sentenceRangeAt", () => {
  it("isolates the sentence around the offset", () => {
    const text = "Перше речення. Друге речення тут. Третє.";
    const offset = text.indexOf("Друге");
    const { start, end } = sentenceRangeAt(text, offset);
    expect(text.slice(start, end)).toBe("Друге речення тут.");
  });

  it("stops at a line break", () => {
    const text = "- перший пункт\n- другий пункт";
    const offset = text.indexOf("другий");
    const { start, end } = sentenceRangeAt(text, offset);
    expect(text.slice(start, end)).toBe("- другий пункт");
  });

  it("does not split a decimal number", () => {
    const text = "Затримка 1.5 секунди на запит.";
    const offset = text.indexOf("секунди");
    expect(text.slice(...Object.values(sentenceRangeAt(text, offset)) as [number, number])).toBe(text);
  });

  it("keeps closing punctuation with the sentence", () => {
    const text = 'Він сказав "ні." Потім пішов.';
    const { start, end } = sentenceRangeAt(text, 0);
    expect(text.slice(start, end)).toBe('Він сказав "ні."');
  });

  it("handles a single sentence with no terminator", () => {
    const text = "Просто текст без крапки";
    expect(sentenceRangeAt(text, 5)).toEqual({ start: 0, end: text.length });
  });
});

describe("applyAlternative", () => {
  const text = "Перше речення. Друге речення тут. Третє.";

  it("replaces only the chosen sentence", () => {
    const range = sentenceRangeAt(text, text.indexOf("Друге"));
    expect(applyAlternative(text, range, "Друге речення інше.")).toBe(
      "Перше речення. Друге речення інше. Третє."
    );
  });

  it("leaves the translation alone when the sentence is empty", () => {
    expect(applyAlternative(text, { start: 0, end: 5 }, "")).toBe(text);
  });

  it("clamps an out-of-range replacement", () => {
    expect(applyAlternative("abc", { start: 99, end: 120 }, "X")).toBe("abcX");
  });
});

describe("alternativesCacheKey", () => {
  it("separates the same word in different sentences", () => {
    const a = alternativesCacheKey({ targetLang: "uk", sentence: "Один текст.", word: "текст", wordOffset: 5 });
    const b = alternativesCacheKey({ targetLang: "uk", sentence: "Інший текст.", word: "текст", wordOffset: 6 });
    expect(a).not.toBe(b);
  });

  it("separates the same sentence in different target languages", () => {
    const base = { sentence: "Same sentence.", word: "sentence", wordOffset: 5 };
    expect(alternativesCacheKey({ ...base, targetLang: "uk" })).not.toBe(
      alternativesCacheKey({ ...base, targetLang: "de" })
    );
  });
});

describe("buildAlternativesPrompt", () => {
  const request = {
    sentence: "Це тестове речення.",
    word: "тестове",
    wordOffset: 3,
    targetLang: "uk" as const
  };

  it("names the language, the word and the JSON shape", () => {
    const prompt = buildAlternativesPrompt(request);
    expect(prompt).toContain("Ukrainian");
    expect(prompt).toContain('"тестове"');
    expect(prompt).toContain('{"alternatives":[{"word"');
    expect(prompt).toContain(String(MAX_ALTERNATIVES));
  });

  it("includes the source text only when there is one", () => {
    expect(buildAlternativesPrompt(request)).not.toContain("translated from");
    expect(buildAlternativesPrompt({ ...request, sourceText: "This is a test sentence." }))
      .toContain("This is a test sentence.");
  });

  it("carries glossary terms so a fixed rendering is not offered away", () => {
    const prompt = buildAlternativesPrompt({
      ...request,
      options: { glossary: [{ term: "rate limit", translations: {} }] }
    });
    expect(prompt).toContain("rate limit");
  });
});

describe("parseAlternativesJson", () => {
  it("parses a plain JSON answer", () => {
    const raw = '{"alternatives":[{"word":"пробне","sentence":"Це пробне речення."}]}';
    expect(parseAlternativesJson(raw, "тестове")).toEqual([
      { word: "пробне", sentence: "Це пробне речення." }
    ]);
  });

  it("parses a code-fenced answer", () => {
    const raw = '```json\n{"alternatives":[{"word":"пробне","sentence":"Це пробне речення."}]}\n```';
    expect(parseAlternativesJson(raw, "тестове")).toHaveLength(1);
  });

  it("parses JSON embedded in commentary", () => {
    const raw = 'Here you go: {"alternatives":[{"word":"пробне","sentence":"Це пробне речення."}]} — enjoy';
    expect(parseAlternativesJson(raw, "тестове")).toHaveLength(1);
  });

  it("drops the clicked word and duplicates, case-insensitively", () => {
    const raw = JSON.stringify({
      alternatives: [
        { word: "тестове", sentence: "Це тестове речення." },
        { word: "Пробне", sentence: "Це пробне речення." },
        { word: "пробне", sentence: "Це пробне речення знову." }
      ]
    });
    expect(parseAlternativesJson(raw, "тестове")).toEqual([
      { word: "Пробне", sentence: "Це пробне речення." }
    ]);
  });

  it("drops entries without a rewritten sentence", () => {
    const raw = JSON.stringify({ alternatives: [{ word: "пробне" }, { sentence: "Без слова." }] });
    expect(parseAlternativesJson(raw, "тестове")).toEqual([]);
  });

  it("caps the list", () => {
    const raw = JSON.stringify({
      alternatives: Array.from({ length: 12 }, (_, i) => ({ word: `w${i}`, sentence: `s${i}` }))
    });
    expect(parseAlternativesJson(raw, "тестове")).toHaveLength(MAX_ALTERNATIVES);
  });

  it("returns an empty list for unparseable or empty output", () => {
    expect(parseAlternativesJson("I cannot help with that", "word")).toEqual([]);
    expect(parseAlternativesJson("", "word")).toEqual([]);
  });
});

describe("clampAlternativesRequest", () => {
  it("trims an oversized sentence and keeps the offset inside it", () => {
    const clamped = clampAlternativesRequest({
      sentence: "x".repeat(5000),
      word: "y".repeat(200),
      wordOffset: 4900,
      targetLang: "uk"
    });
    expect(clamped.sentence).toHaveLength(1000);
    expect(clamped.word).toHaveLength(80);
    expect(clamped.wordOffset).toBeLessThanOrEqual(1000);
  });

  it("normalizes a nonsense offset", () => {
    const clamped = clampAlternativesRequest({
      sentence: "Коротке речення.",
      word: "Коротке",
      wordOffset: -7,
      targetLang: "uk"
    });
    expect(clamped.wordOffset).toBe(0);
  });
});
