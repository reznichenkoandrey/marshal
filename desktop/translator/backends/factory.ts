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

/** What `auto` needs to know about the environment to resolve sensibly. */
export interface TranslatorAutoContext {
  /** MARSHAL_API_KEY is configured, so the fast OpenAI-compatible path works. */
  apiKeyPresent?: boolean;
  /** `process.platform` — Apple Vision OCR exists only on macOS. */
  platform?: NodeJS.Platform;
}

/**
 * Codex CLI spawns a process per call; measured ~10 s per sentence. Claude CLI
 * keeps a warm process and answers in ~1 s, so `auto` leaves it alone (#344).
 */
function isSlowBackend(id: TranslatorBackendId): boolean {
  return id === "codex-cli";
}

/**
 * Fast path for `auto`. On macOS this is the Apple Vision hybrid: text goes
 * through the same OpenAI-compatible provider, but OCR runs locally, which is
 * quicker than a vision API and has no per-image limit.
 */
function fastBackend(platform: NodeJS.Platform | undefined): TranslatorBackendId {
  return platform === "darwin" ? "apple-vision" : "openai-api";
}

/** The plain "follow the main provider" mapping, with no latency override. */
function bridgeBackend(mode: TranslatorBridgeMode): TranslatorBackendId {
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
      // Browser automation is impractical for low-latency translation.
      return "claude-cli";
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown bridge mode: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Maps the main "Reasoning provider" choice onto a translator backend, so the
 * translator follows whichever provider the user configured — with one
 * exception.
 *
 * The translator translates while the user types (650 ms debounce). The Codex
 * CLI answers in about ten seconds, which turns that into a lag rather than a
 * feature. So when the provider would resolve to Codex CLI AND an API key is
 * configured, the translator takes the API instead: sub-second, and the agent
 * keeps its own provider untouched. Claude CLI used to be in this bucket too;
 * since #344 it answers in about a second and stays on the subscription.
 *
 * Providers that are already API-based are left alone — they are fast enough,
 * and silently moving them to another vendor would move the billing too.
 * See #155.
 */
export function translatorBackendForBridge(
  mode: TranslatorBridgeMode,
  context: TranslatorAutoContext = {}
): TranslatorBackendId {
  const mapped = bridgeBackend(mode);
  if (isSlowBackend(mapped) && context.apiKeyPresent) {
    return fastBackend(context.platform);
  }
  return mapped;
}
