// desktop/translator/translator-service.ts
// Translator facade: picks a backend (Claude CLI / Codex CLI / Claude API /
// OpenAI-compatible) and delegates translateText/translateImage/translateAuto
// to it. Can follow the main "Reasoning provider" setting ("auto") or be
// pinned to an explicit backend.

import { createTranslatorBackend, resolveTranslatorBackendId, translatorBackendForBridge } from "./backends/factory.ts";
import { detectLangHeuristic } from "./backends/shared.ts";
import type {
  TargetLang,
  TranslationResult,
  TranslatorBackend,
  TranslatorBackendId,
  TranslatorBridgeMode
} from "./backends/types.ts";

export type { TargetLang, TranslationResult, TranslatorBackendId } from "./backends/types.ts";

export type TranslatorBackendChoice = TranslatorBackendId | "auto";

const DEFAULT_BRIDGE: TranslatorBridgeMode = "claude-cli";

export interface TranslatorServiceInit {
  choice?: TranslatorBackendChoice;
  bridgeMode?: TranslatorBridgeMode;
}

export class TranslatorService {
  private backend: TranslatorBackend;
  private choice: TranslatorBackendChoice;
  private bridgeMode: TranslatorBridgeMode;

  constructor(init: TranslatorServiceInit = {}) {
    this.bridgeMode = init.bridgeMode ?? DEFAULT_BRIDGE;
    this.choice = init.choice ?? "auto";
    this.backend = createTranslatorBackend(this.resolveBackendId());
  }

  /** The concrete backend currently servicing translations. */
  get backendId(): TranslatorBackendId {
    return this.backend.id;
  }

  /** Swap the backend choice at runtime (e.g. after Settings change). */
  setBackend(choice: TranslatorBackendChoice): void {
    this.choice = choice;
    this.rebuildBackend();
  }

  /** React to a "Reasoning provider" change so `auto` stays in sync. */
  setBridgeMode(mode: TranslatorBridgeMode): void {
    if (this.bridgeMode === mode) return;
    this.bridgeMode = mode;
    if (this.choice === "auto") {
      this.rebuildBackend();
    }
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

  private resolveBackendId(): TranslatorBackendId {
    if (this.choice === "auto") {
      return translatorBackendForBridge(this.bridgeMode);
    }
    return this.choice;
  }

  private rebuildBackend(): void {
    const id = this.resolveBackendId();
    if (this.backend.id === id) return;
    this.backend = createTranslatorBackend(id);
  }
}

export function resolveTranslatorChoice(raw: string | undefined, fallback: TranslatorBackendChoice): TranslatorBackendChoice {
  if (typeof raw !== "string") return fallback;
  const candidate = raw.trim().toLowerCase();
  if (candidate === "auto") return "auto";
  return resolveTranslatorBackendId(candidate, fallback === "auto" ? "claude-cli" : fallback);
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
