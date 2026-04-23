import { describe, expect, it } from "vitest";

import {
  createTranslatorBackend,
  resolveTranslatorBackendId,
  VALID_TRANSLATOR_BACKENDS
} from "../desktop/translator/backends/factory.ts";
import { ClaudeCliTranslatorBackend } from "../desktop/translator/backends/claude-cli-backend.ts";
import { CodexCliTranslatorBackend } from "../desktop/translator/backends/codex-cli-backend.ts";
import { GroqTranslatorBackend } from "../desktop/translator/backends/groq-backend.ts";

describe("createTranslatorBackend", () => {
  it("returns the ClaudeCliTranslatorBackend for `claude-cli`", () => {
    const backend = createTranslatorBackend("claude-cli");
    expect(backend).toBeInstanceOf(ClaudeCliTranslatorBackend);
    expect(backend.id).toBe("claude-cli");
  });

  it("returns the CodexCliTranslatorBackend for `codex-cli`", () => {
    const backend = createTranslatorBackend("codex-cli");
    expect(backend).toBeInstanceOf(CodexCliTranslatorBackend);
    expect(backend.id).toBe("codex-cli");
  });

  it("returns the GroqTranslatorBackend for `groq`", () => {
    const backend = createTranslatorBackend("groq");
    expect(backend).toBeInstanceOf(GroqTranslatorBackend);
    expect(backend.id).toBe("groq");
  });
});

describe("resolveTranslatorBackendId", () => {
  it("accepts every valid id", () => {
    for (const id of VALID_TRANSLATOR_BACKENDS) {
      expect(resolveTranslatorBackendId(id, "claude-cli")).toBe(id);
    }
  });

  it("normalises case + trims whitespace", () => {
    expect(resolveTranslatorBackendId("  CLAUDE-CLI  ", "groq")).toBe("claude-cli");
    expect(resolveTranslatorBackendId("Codex-Cli", "groq")).toBe("codex-cli");
  });

  it("falls back for undefined/unknown inputs", () => {
    expect(resolveTranslatorBackendId(undefined, "groq")).toBe("groq");
    expect(resolveTranslatorBackendId("mistral", "claude-cli")).toBe("claude-cli");
    expect(resolveTranslatorBackendId("", "claude-cli")).toBe("claude-cli");
  });
});
