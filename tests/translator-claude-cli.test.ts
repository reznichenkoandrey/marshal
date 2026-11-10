import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseTranslateJson, unwrapOcrLines, buildOcrTranslateJsonPrompt } from "../desktop/translator/backends/shared.ts";

// A stand-in `claude`: logs its argv and env, waits for one stream-json user
// message, answers with the `result` line the real CLI ends a turn with.
const dir = mkdtempSync(path.join(tmpdir(), "marshal-fake-claude-"));
const log = path.join(dir, "calls.jsonl");
const fakeBin = path.join(dir, "claude");
writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  if (!input.trim()) process.exit(0);
  const message = JSON.parse(input.trim().split("\\n")[0]).message;
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
    argv: process.argv.slice(2),
    flag: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    content: message.content
  }) + "\\n");
  const isImage = Array.isArray(message.content);
  const answer = isImage
    ? { sourceLang: "en", source: "Cancel anytime.", translation: "Скасуйте будь-коли." }
    : { sourceLang: "en", translation: "Привіт" };
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  if (process.env.FAKE_CLAUDE_FAIL) {
    console.log(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }));
  } else {
    console.log(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(answer) }));
  }
});
`);
chmodSync(fakeBin, 0o755);

process.env.MARSHAL_CLAUDE_BIN = fakeBin;
process.env.ANTHROPIC_API_KEY = "sk-must-not-leak";
process.env.MARSHAL_CLAUDE_MODEL = "opus";
delete process.env.MARSHAL_TRANSLATOR_CLAUDE_MODEL;
const { ClaudeCliTranslatorBackend, parseStreamResult, translatorClaudeModel } = await import(
  "../desktop/translator/backends/claude-cli-backend.ts"
);

function calls(): Array<{ argv: string[]; flag?: string; apiKey: string | null; content: unknown }> {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const backend = new ClaudeCliTranslatorBackend();
afterAll(() => backend.dispose());

describe("Claude CLI translator backend (#344)", () => {
  it("translates text through a lean, subscription-billed process on its own model", async () => {
    const result = await backend.translateText("Hello", "uk");
    expect(result).toEqual({ translation: "Привіт", sourceLang: "en", targetLang: "uk" });

    const call = calls().at(-1)!;
    expect(call.apiKey).toBeNull();
    expect(call.flag).toBe("1");
    // Its own model, not the agent's opus.
    expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("haiku");
    expect(call.argv[call.argv.indexOf("--tools") + 1]).toBe("");
    expect(call.argv[call.argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(call.argv).toContain("--strict-mcp-config");
  });

  it("sends an image as an image block and returns what it read", async () => {
    const result = await backend.translateImage("aGVsbG8=", "image/png", "uk");
    expect(result).toEqual({
      translation: "Скасуйте будь-коли.",
      sourceLang: "en",
      targetLang: "uk",
      sourceText: "Cancel anytime."
    });
    const content = calls().at(-1)!.content as Array<{ type: string; source?: { data: string } }>;
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } });
    expect(content[1]?.type).toBe("text");
  });

  it("serves overlapping requests without mixing answers", async () => {
    const [a, b] = await Promise.all([backend.translateText("one", "uk"), backend.translateText("two", "uk")]);
    expect(a.translation).toBe("Привіт");
    expect(b.translation).toBe("Привіт");
  });

  it("turns an is_error result into a rejection", async () => {
    process.env.FAKE_CLAUDE_FAIL = "1";
    const failing = new ClaudeCliTranslatorBackend();
    try {
      await expect(failing.translateText("x", "uk")).rejects.toThrow(/Not logged in/u);
    } finally {
      failing.dispose();
      delete process.env.FAKE_CLAUDE_FAIL;
    }
  });

  it("reads its model from MARSHAL_TRANSLATOR_CLAUDE_MODEL only", () => {
    expect(translatorClaudeModel({ MARSHAL_CLAUDE_MODEL: "opus" })).toBe("haiku");
    expect(translatorClaudeModel({ MARSHAL_TRANSLATOR_CLAUDE_MODEL: " sonnet " })).toBe("sonnet");
  });

  it("recognizes only the final result line of the stream", () => {
    expect(parseStreamResult('{"type":"assistant","message":{}}')).toBeNull();
    expect(parseStreamResult("not json")).toBeNull();
    expect(parseStreamResult('{"type":"result","is_error":false,"result":"ok"}')).toEqual({ ok: true, text: "ok" });
    expect(parseStreamResult('{"type":"result","is_error":true,"result":"boom"}')).toEqual({ ok: false, text: "boom" });
  });
});

describe("image prompt and OCR text", () => {
  it("asks for the recognized text alongside the translation", () => {
    const prompt = buildOcrTranslateJsonPrompt("uk");
    expect(prompt).toContain('"source"');
    expect(prompt).toContain("Ukrainian");
    expect(parseTranslateJson('{"sourceLang":"en","source":"Hi","translation":"Привіт"}'))
      .toEqual({ sourceLang: "en", source: "Hi", translation: "Привіт" });
  });

  it("joins lines the layout wrapped mid-sentence", () => {
    const ocr = [
      "Ми отримали ваше повідомлення щодо оплати рахунку. Будь ласка,",
      "перевірте, чи правильно вказані реквізити, і надішліть підтвердження до",
      "пʼятниці.",
      "Your subscription will renew automatically on December 3. If you don't want to be",
      "charged, cancel in Account Settings."
    ].join("\n");
    expect(unwrapOcrLines(ocr)).toBe(
      "Ми отримали ваше повідомлення щодо оплати рахунку. Будь ласка, перевірте, чи правильно вказані " +
      "реквізити, і надішліть підтвердження до пʼятниці.\n" +
      "Your subscription will renew automatically on December 3. If you don't want to be charged, cancel in Account Settings."
    );
  });

  it("keeps short UI labels and hyphenated words apart correctly", () => {
    expect(unwrapOcrLines("Settings\nAccount\nPrivacy")).toBe("Settings\nAccount\nPrivacy");
    expect(unwrapOcrLines("This is a long line of prose that ends with a hyphen-\nated word.")).toBe(
      "This is a long line of prose that ends with a hyphenated word."
    );
    expect(unwrapOcrLines("First paragraph ends here.\n\nSecond one.")).toBe("First paragraph ends here.\n\nSecond one.");
  });
});
