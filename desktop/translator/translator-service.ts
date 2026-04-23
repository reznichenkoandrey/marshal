// desktop/translator/translator-service.ts
// Translator facade: picks a backend (Claude CLI / Codex CLI / Groq) and
// delegates translateText/translateImage/translateAuto to it.

import { createTranslatorBackend, resolveTranslatorBackendId } from "./backends/factory.ts";
import { detectLangHeuristic } from "./backends/shared.ts";
import type {
  TargetLang,
  TranslationResult,
  TranslatorBackend,
  TranslatorBackendId
} from "./backends/types.ts";

export type { TargetLang, TranslationResult, TranslatorBackendId } from "./backends/types.ts";

const DEFAULT_BACKEND: TranslatorBackendId = "claude-cli";

export class TranslatorService {
  private backend: TranslatorBackend;

  constructor(backendId?: TranslatorBackendId) {
    const id = backendId ?? resolveTranslatorBackendId(process.env.MARSHAL_TRANSLATOR_BACKEND, DEFAULT_BACKEND);
    this.backend = createTranslatorBackend(id);
  }

  get backendId(): TranslatorBackendId {
    return this.backend.id;
  }

  /** Swap the backend at runtime (e.g. after Settings change). */
  setBackend(id: TranslatorBackendId): void {
    if (this.backend.id === id) return;
    this.backend = createTranslatorBackend(id);
  }

  translateText(text: string, targetLang: TargetLang): Promise<TranslationResult> {
    return this.backend.translateText(text, targetLang);
  }

  translateImage(base64: string, mimeType: string, targetLang: TargetLang): Promise<TranslationResult> {
    return this.backend.translateImage(base64, mimeType, targetLang);
  }

  /** Detects the source language heuristically and translates to the opposite (uk↔en). */
  translateAuto(text: string): Promise<TranslationResult> {
    // Heuristic picks translation direction up-front. A Cyrillic sample is
    // Ukrainian (or near enough for this feature); everything else targets
    // Ukrainian. This removes the extra detect-language round trip and makes
    // direction decisions deterministic even when the backend call later fails.
    const heuristic = detectLangHeuristic(text);
    const targetLang: TargetLang = heuristic === "uk" ? "en" : "uk";
    return this.backend.translateText(text, targetLang);
  }
}

// Re-export helpers so existing tests can import them from this module.
export {
  detectLangHeuristic,
  extractBracedJson,
  parseFloatEnv,
  parseIntEnv,
  parseRetryAfterMs,
  parseTranslateJson,
  stripCodeFence
} from "./backends/shared.ts";
export type { TranslateJsonResult } from "./backends/shared.ts";
