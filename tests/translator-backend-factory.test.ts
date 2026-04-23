import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createTranslatorBackend,
  resolveTranslatorBackendId,
  translatorBackendForBridge,
  VALID_TRANSLATOR_BACKENDS
} from "../desktop/translator/backends/factory.ts";
import { ClaudeApiTranslatorBackend } from "../desktop/translator/backends/claude-api-backend.ts";
import { ClaudeCliTranslatorBackend } from "../desktop/translator/backends/claude-cli-backend.ts";
import { CodexCliTranslatorBackend } from "../desktop/translator/backends/codex-cli-backend.ts";
import { OpenAiApiTranslatorBackend } from "../desktop/translator/backends/openai-api-backend.ts";

// Claude API + OpenAI-compatible backends read creds at construct time.
// Provide dummy values so instantiation doesn't throw in unit tests.
let originalAnthropicKey: string | undefined;
let originalMarshalKey: string | undefined;

beforeEach(() => {
  originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  originalMarshalKey = process.env.MARSHAL_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-anthropic";
  process.env.MARSHAL_API_KEY = "test-marshal";
});

afterEach(() => {
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  if (originalMarshalKey === undefined) delete process.env.MARSHAL_API_KEY;
  else process.env.MARSHAL_API_KEY = originalMarshalKey;
});

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

  it("returns the ClaudeApiTranslatorBackend for `claude-api`", () => {
    const backend = createTranslatorBackend("claude-api");
    expect(backend).toBeInstanceOf(ClaudeApiTranslatorBackend);
    expect(backend.id).toBe("claude-api");
  });

  it("returns the OpenAiApiTranslatorBackend for `openai-api`", () => {
    const backend = createTranslatorBackend("openai-api");
    expect(backend).toBeInstanceOf(OpenAiApiTranslatorBackend);
    expect(backend.id).toBe("openai-api");
  });

  it("routes the legacy `groq` alias to the OpenAI-compatible backend", () => {
    const backend = createTranslatorBackend("groq");
    expect(backend).toBeInstanceOf(OpenAiApiTranslatorBackend);
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
    expect(resolveTranslatorBackendId("  CLAUDE-CLI  ", "openai-api")).toBe("claude-cli");
    expect(resolveTranslatorBackendId("Codex-Cli", "openai-api")).toBe("codex-cli");
  });

  it("falls back for undefined/unknown inputs", () => {
    expect(resolveTranslatorBackendId(undefined, "openai-api")).toBe("openai-api");
    expect(resolveTranslatorBackendId("mistral", "claude-cli")).toBe("claude-cli");
    expect(resolveTranslatorBackendId("", "claude-cli")).toBe("claude-cli");
  });
});

describe("translatorBackendForBridge", () => {
  it("maps CLI bridges to their matching CLI translator", () => {
    expect(translatorBackendForBridge("claude-cli")).toBe("claude-cli");
    expect(translatorBackendForBridge("codex-cli")).toBe("codex-cli");
  });

  it("maps API bridges to their matching API translator", () => {
    expect(translatorBackendForBridge("claude")).toBe("claude-api");
    expect(translatorBackendForBridge("api")).toBe("openai-api");
  });

  it("falls back to claude-cli for browser-automation bridges", () => {
    expect(translatorBackendForBridge("claude-web")).toBe("claude-cli");
    expect(translatorBackendForBridge("playwright")).toBe("claude-cli");
    expect(translatorBackendForBridge("extension")).toBe("claude-cli");
  });
});
