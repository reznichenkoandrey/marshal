// Dictation prompt assembly (#261, #289) and the hallucination guard before
// paste. Whisper keeps only the last 223 prompt tokens, so the tests pin the
// budget, the order (most important last) and the blank-prompt contract.

import { describe, expect, it } from "vitest";

import { transcriptToDeliver } from "../desktop/dictation/dictation-service.ts";
import {
  buildDictationPrompt,
  DEFAULT_DICTATION_PROMPT,
  DICTATION_PROMPT_TOKEN_BUDGET,
  estimateWhisperTokens
} from "../desktop/dictation/whisper-backend.ts";

const WHISPER_PROMPT_WINDOW = 223;
const DIRECTIVE = "Дослівно, із суржиком та англіцизмами, як вимовлено.";

describe("estimateWhisperTokens", () => {
  // Real counts from openai/whisper's multilingual.tiktoken.
  const measured: Array<[string, number]> = [
    [DEFAULT_DICTATION_PROMPT, 164],
    [DIRECTIVE, 28],
    ["NSB-628, CHOCO-13, feature/dictation-glossary-prompt, v0.4.0, #218, MARSHAL_API_KEY, 127.0.0.1:8766", 56],
    ["гіперпараметри, перепідключення, неймовірно, багатопотоковість, ініціалізація", 35],
    ["please refactor the translator backend and rerun the whisper benchmark on staging", 14]
  ];

  it("never undercounts the real tokenizer", () => {
    for (const [text, real] of measured) {
      expect(estimateWhisperTokens(text), text).toBeGreaterThanOrEqual(real);
    }
  });
});

describe("buildDictationPrompt", () => {
  it("fits the default prompt in whisper's window with the directive last", () => {
    const prompt = buildDictationPrompt(undefined);
    expect(prompt).toBe(DEFAULT_DICTATION_PROMPT);
    expect(estimateWhisperTokens(prompt)).toBeLessThanOrEqual(DICTATION_PROMPT_TOKEN_BUDGET);
    expect(prompt.endsWith(DIRECTIVE)).toBe(true);
  });

  it("appends glossary terms after the prompt, newest last", () => {
    const prompt = buildDictationPrompt(undefined, ["product_flat", "rate limit"]);
    expect(prompt.endsWith(`${DIRECTIVE} product_flat, rate limit.`)).toBe(true);
  });

  it("skips terms the prompt already names and duplicates", () => {
    const prompt = buildDictationPrompt("React, Magento.", ["magento", "  Hyva ", "Hyva", ""]);
    expect(prompt).toBe("React, Magento. Hyva.");
  });

  it("drops the leading vocabulary, not the directive or the newest terms, when over budget", () => {
    const terms = Array.from({ length: 60 }, (_, index) => `term_${index}`);
    const prompt = buildDictationPrompt(undefined, terms);
    expect(estimateWhisperTokens(prompt)).toBeLessThanOrEqual(DICTATION_PROMPT_TOKEN_BUDGET);
    expect(DICTATION_PROMPT_TOKEN_BUDGET).toBeLessThan(WHISPER_PROMPT_WINDOW);
    expect(prompt).toContain(DIRECTIVE);
    expect(prompt.endsWith("term_59.")).toBe(true);
    expect(prompt).not.toContain("term_0,");
    expect(prompt.startsWith("Інструменти:")).toBe(false);
  });

  it("trims a long custom prompt from the start at a word boundary", () => {
    const custom = Array.from({ length: 200 }, (_, index) => `слово${index}`).join(" ");
    const prompt = buildDictationPrompt(custom);
    expect(estimateWhisperTokens(prompt)).toBeLessThanOrEqual(DICTATION_PROMPT_TOKEN_BUDGET);
    expect(prompt.endsWith("слово199")).toBe(true);
    expect(custom.includes(` ${prompt}`)).toBe(true);
  });

  it("keeps a blanked prompt blank, glossary or not", () => {
    expect(buildDictationPrompt("", ["product_flat"])).toBe("");
    expect(buildDictationPrompt("   ", ["product_flat"])).toBe("");
  });
});

describe("transcriptToDeliver", () => {
  it("pastes nothing for whisper's silence filler", () => {
    for (const text of ["Дякую за перегляд.", "Дякую за перегляд!", "Субтитри зроблені спільнотою Amara.org", "Thank you.", "[BLANK_AUDIO]", "..."]) {
      expect(transcriptToDeliver(text), text).toBe("");
    }
  });

  it("keeps real dictation, including lines that mention subtitles or thanks", () => {
    for (const text of ["Субтитри у вікні не видно.", "Дякую, задеплоїв на staging.", "Запушив PR."]) {
      expect(transcriptToDeliver(text), text).toBe(text);
    }
  });
});
