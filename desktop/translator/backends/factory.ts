import { ClaudeCliTranslatorBackend } from "./claude-cli-backend.ts";
import { CodexCliTranslatorBackend } from "./codex-cli-backend.ts";
import { GroqTranslatorBackend } from "./groq-backend.ts";
import type { TranslatorBackend, TranslatorBackendId } from "./types.ts";

export const VALID_TRANSLATOR_BACKENDS: readonly TranslatorBackendId[] = [
  "claude-cli",
  "codex-cli",
  "groq"
];

export function createTranslatorBackend(id: TranslatorBackendId): TranslatorBackend {
  switch (id) {
    case "claude-cli":
      return new ClaudeCliTranslatorBackend();
    case "codex-cli":
      return new CodexCliTranslatorBackend();
    case "groq":
      return new GroqTranslatorBackend();
    default: {
      // Exhaustive check — compilation fails if a new id is added without a case.
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
