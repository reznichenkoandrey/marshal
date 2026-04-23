import { AppleVisionTranslatorBackend } from "./apple-vision-backend.ts";
import { ClaudeApiTranslatorBackend } from "./claude-api-backend.ts";
import { ClaudeCliTranslatorBackend } from "./claude-cli-backend.ts";
import { CodexCliTranslatorBackend } from "./codex-cli-backend.ts";
import { OpenAiApiTranslatorBackend } from "./openai-api-backend.ts";
import type { TranslatorBackend, TranslatorBackendId, TranslatorBridgeMode } from "./types.ts";

export const VALID_TRANSLATOR_BACKENDS: readonly TranslatorBackendId[] = [
  "claude-cli",
  "codex-cli",
  "claude-api",
  "openai-api",
  "groq",
  "apple-vision"
];

export function createTranslatorBackend(id: TranslatorBackendId): TranslatorBackend {
  switch (id) {
    case "claude-cli":
      return new ClaudeCliTranslatorBackend();
    case "codex-cli":
      return new CodexCliTranslatorBackend();
    case "claude-api":
      return new ClaudeApiTranslatorBackend();
    case "openai-api":
      return new OpenAiApiTranslatorBackend("openai-api");
    case "groq":
      // Legacy alias kept for existing settings.json files. Same transport as
      // openai-api but preserves the historical id in the resolved backend.
      return new OpenAiApiTranslatorBackend("groq");
    case "apple-vision":
      return new AppleVisionTranslatorBackend();
    default: {
      const _exhaustive: never = id;
      throw new Error(`Unknown translator backend: ${String(_exhaustive)}`);
    }
  }
}

export function resolveTranslatorBackendId(raw: string | undefined, fallback: TranslatorBackendId): TranslatorBackendId {
  if (typeof raw !== "string") return fallback;
  const candidate = raw.trim().toLowerCase();
  return (VALID_TRANSLATOR_BACKENDS as readonly string[]).includes(candidate)
    ? (candidate as TranslatorBackendId)
    : fallback;
}

/**
 * Maps the main "Reasoning provider" choice onto a translator backend so the
 * translator silently follows whichever provider the user configured. Browser
 * automation modes (claude-web / playwright / extension) are impractical for
 * low-latency translation, so we fall back to the Claude CLI subscription.
 */
export function translatorBackendForBridge(mode: TranslatorBridgeMode): TranslatorBackendId {
  switch (mode) {
    case "claude-cli":
      return "claude-cli";
    case "codex-cli":
      return "codex-cli";
    case "claude":
      return "claude-api";
    case "api":
      return "openai-api";
    case "claude-web":
    case "playwright":
    case "extension":
      return "claude-cli";
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown bridge mode: ${String(_exhaustive)}`);
    }
  }
}
