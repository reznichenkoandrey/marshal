// desktop/translator/translator-service.ts
// Translator facade: picks a backend (Claude CLI / Codex CLI / Claude API /
// OpenAI-compatible) and delegates translateText/translateImage/translateAuto
// to it. Can follow the main "Reasoning provider" setting ("auto") or be
// pinned to an explicit backend. Also owns the active language pair, which the
// hotkey path needs in order to choose a direction on its own.

import { createTranslatorBackend, resolveTranslatorBackendId, translatorBackendForBridge } from "./backends/factory.ts";
import { detectScriptLang } from "./languages.ts";
import type {
  Formality,
  LangCode,
  SourceLang,
  TargetLang,
  TranslateOptions,
  TranslationResult,
  TranslatorBackend,
  TranslatorBackendId,
  TranslatorBridgeMode
} from "./backends/types.ts";

export type {
  Formality,
  LangCode,
  SourceLang,
  TargetLang,
  TranslateOptions,
  TranslationResult,
  TranslatorBackendId
} from "./backends/types.ts";

export type TranslatorBackendChoice = TranslatorBackendId | "auto";

const DEFAULT_BRIDGE: TranslatorBridgeMode = "claude-cli";
const DEFAULT_SOURCE: SourceLang = "auto";
const DEFAULT_TARGET: TargetLang = "uk";
/** Pair the app falls back to when auto-detect lands on the target language. */
const NATIVE_PAIR: readonly [LangCode, LangCode] = ["uk", "en"];

export interface TranslatorServiceInit {
  choice?: TranslatorBackendChoice;
  bridgeMode?: TranslatorBridgeMode;
  sourceLang?: SourceLang;
  targetLang?: TargetLang;
  formality?: Formality;
}

export class TranslatorService {
  private backend: TranslatorBackend;
  private choice: TranslatorBackendChoice;
  private bridgeMode: TranslatorBridgeMode;
  private sourceLang: SourceLang;
  private targetLang: TargetLang;
  private formality: Formality;

  constructor(init: TranslatorServiceInit = {}) {
    this.bridgeMode = init.bridgeMode ?? DEFAULT_BRIDGE;
    this.choice = init.choice ?? "auto";
    this.sourceLang = init.sourceLang ?? DEFAULT_SOURCE;
    this.targetLang = init.targetLang ?? DEFAULT_TARGET;
    this.formality = init.formality ?? "default";
    this.backend = createTranslatorBackend(this.resolveBackendId());
  }

  /** The concrete backend currently servicing translations. */
  get backendId(): TranslatorBackendId {
    return this.backend.id;
  }

  /** Language pair the hotkey / OCR paths translate with. */
  get languagePair(): { sourceLang: SourceLang; targetLang: TargetLang; formality: Formality } {
    return { sourceLang: this.sourceLang, targetLang: this.targetLang, formality: this.formality };
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

  /** Called whenever the renderer changes the pair, so hotkeys follow the UI. */
  setLanguagePair(sourceLang: SourceLang, targetLang: TargetLang, formality: Formality = this.formality): void {
    this.sourceLang = sourceLang;
    this.targetLang = targetLang;
    this.formality = formality;
  }

  translateText(text: string, targetLang: TargetLang, options?: TranslateOptions): Promise<TranslationResult> {
    return this.backend.translateText(text, targetLang, this.withDefaults(options));
  }

  translateImage(
    base64: string,
    mimeType: string,
    targetLang: TargetLang,
    options?: TranslateOptions
  ): Promise<TranslationResult> {
    return this.backend.translateImage(base64, mimeType, targetLang, this.withDefaults(options));
  }

  /**
   * Translates without the UI telling us a direction — the double-⌘C and
   * ⌘⌥T hotkeys. The script heuristic decides direction up front: text that
   * is already in the target language goes the other way, everything else
   * goes to the target. Deterministic, and it still holds when the backend
   * call later fails.
   */
  translateAuto(text: string): Promise<TranslationResult> {
    return this.backend.translateText(text, this.autoTarget(text), {
      sourceLang: "auto",
      formality: this.formality
    });
  }

  /** Target language `translateAuto` would pick for this text. */
  autoTarget(text: string): TargetLang {
    const detected = detectScriptLang(text);
    if (detected !== this.targetLang) return this.targetLang;
    if (this.sourceLang !== "auto") return this.sourceLang;
    // Both sides are the same language: flip within the app's native pair.
    const [first, second] = NATIVE_PAIR;
    return this.targetLang === first ? second : first;
  }

  /** Fills in the configured source/formality for callers that omit them. */
  private withDefaults(options: TranslateOptions | undefined): TranslateOptions {
    return {
      sourceLang: options?.sourceLang ?? this.sourceLang,
      formality: options?.formality ?? this.formality
    };
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
