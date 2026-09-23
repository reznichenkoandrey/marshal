import { afterEach, describe, expect, it } from "vitest";

import { ClaudeApiTranslatorBackend } from "../desktop/translator/backends/claude-api-backend.ts";
import { createTranslatorBackend } from "../desktop/translator/backends/factory.ts";

const original = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = original;
});

describe("backends do not throw in their constructors (#156)", () => {
  it("builds the claude-api backend without a key and fails only when asked to translate", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const backend = new ClaudeApiTranslatorBackend();
    expect(backend.id).toBe("claude-api");
    await expect(backend.translateText("hello", "uk")).rejects.toThrow(/ANTHROPIC_API_KEY/u);
    await expect(backend.translateImage("AA==", "image/png", "uk")).rejects.toThrow(/ANTHROPIC_API_KEY/u);
  });

  it("the factory can build every backend id with an empty environment", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MARSHAL_API_KEY;
    for (const id of ["claude-cli", "codex-cli", "claude-api", "openai-api", "groq", "apple-vision"] as const) {
      expect(() => createTranslatorBackend(id)).not.toThrow();
    }
  });
});
