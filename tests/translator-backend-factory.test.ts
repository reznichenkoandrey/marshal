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
  // No context = no API key known, which is the historical behaviour.
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

// A CLI backend answers in about ten seconds (measured: 9.7 s for one
// sentence through claude-cli), and the translator translates while the user
// types. When an API key exists, `auto` must take the fast path instead —
// see #155.
describe("translatorBackendForBridge with an API key available", () => {
  const withKey = { apiKeyPresent: true };

  it("replaces a CLI backend with the local-OCR hybrid on macOS", () => {
    expect(translatorBackendForBridge("claude-cli", { ...withKey, platform: "darwin" }))
      .toBe("apple-vision");
    expect(translatorBackendForBridge("codex-cli", { ...withKey, platform: "darwin" }))
      .toBe("apple-vision");
  });

  it("replaces a CLI backend with the plain API elsewhere", () => {
    expect(translatorBackendForBridge("claude-cli", { ...withKey, platform: "linux" }))
      .toBe("openai-api");
    expect(translatorBackendForBridge("codex-cli", { ...withKey, platform: "win32" }))
      .toBe("openai-api");
  });

  it("also covers the browser-automation bridges, which map to a CLI backend", () => {
    for (const mode of ["claude-web", "playwright", "extension"] as const) {
      expect(translatorBackendForBridge(mode, { ...withKey, platform: "darwin" }))
        .toBe("apple-vision");
    }
  });

  it("leaves API providers alone — they are fast, and moving them moves the billing", () => {
    expect(translatorBackendForBridge("claude", { ...withKey, platform: "darwin" }))
      .toBe("claude-api");
    expect(translatorBackendForBridge("api", { ...withKey, platform: "darwin" }))
      .toBe("openai-api");
  });

  it("changes nothing when no key is configured", () => {
    const noKey = { apiKeyPresent: false, platform: "darwin" as NodeJS.Platform };
    expect(translatorBackendForBridge("claude-cli", noKey)).toBe("claude-cli");
    expect(translatorBackendForBridge("codex-cli", noKey)).toBe("codex-cli");
    expect(translatorBackendForBridge("claude-web", noKey)).toBe("claude-cli");
  });
});
