import type { GlossaryEntry } from "../glossary-store.ts";
import type { LangCode, SourceLang } from "../languages.ts";

export type { LangCode, SourceLang } from "../languages.ts";

/**
 * Target language of a translation. Any code from the language registry —
 * `uk` and `en` are just the defaults the UI starts on.
 */
export type TargetLang = LangCode;

/** Register/tone request passed into the prompt. */
export type Formality = "default" | "formal" | "informal";

/**
 * Per-call knobs. Every field is optional so a backend called with only
 * `(text, targetLang)` keeps its historical behaviour: detect the source
 * language, neutral formality.
 */
export interface TranslateOptions {
  /** `auto` (or omitted) lets the model detect the source language. */
  sourceLang?: SourceLang;
  formality?: Formality;
  /**
   * Fixed terms for this call. Already filtered to the ones occurring in the
   * text — see selectGlossaryEntries — so the prompt stays short.
   */
  glossary?: readonly GlossaryEntry[];
}

/**
 * Concrete translator backends. `groq` is kept as a legacy alias for
 * `openai-api` so existing settings files keep working after the rename.
 */
export type TranslatorBackendId =
  | "claude-cli"
  | "codex-cli"
  | "claude-api"
  | "openai-api"
  | "groq"
  | "apple-vision";

/**
 * Reasoning provider selected in Settings → Reasoning provider. Mirrors the
 * `BridgeMode` union from settings-store. Duplicated here to avoid a circular
 * import (settings-store depends on TranslatorBackendId).
 */
export type TranslatorBridgeMode =
  | "claude-cli"
  | "codex-cli"
  | "claude"
  | "api"
  | "claude-web"
  | "playwright"
  | "extension";

export interface TranslationResult {
  translation: string;
  sourceLang: string;
  targetLang: TargetLang;
}

/**
 * One word of a finished translation, with the sentence it sits in. The
 * renderer resolves both before asking — see
 * desktop/renderer/translator-alternatives.js — so the prompt carries a
 * sentence instead of the whole pane.
 */
export interface AlternativesRequest {
  /** The sentence containing the clicked word, as currently rendered. */
  sentence: string;
  /** The clicked word itself. */
  word: string;
  /** Where `word` starts inside `sentence`; disambiguates repeated words. */
  wordOffset: number;
  targetLang: TargetLang;
  /** The original text, when the window still has it — helps fidelity. */
  sourceText?: string;
  options?: TranslateOptions;
}

/**
 * An alternative rendering. `sentence` is the whole sentence rewritten around
 * `word`, so applying a choice costs no second round trip and the rest of the
 * wording still agrees grammatically.
 */
export interface AlternativeOption {
  word: string;
  sentence: string;
}

export interface AlternativesResult {
  alternatives: AlternativeOption[];
}

export interface TranslatorBackend {
  readonly id: TranslatorBackendId;
  translateText(text: string, targetLang: TargetLang, options?: TranslateOptions): Promise<TranslationResult>;
  translateImage(
    base64: string,
    mimeType: string,
    targetLang: TargetLang,
    options?: TranslateOptions
  ): Promise<TranslationResult>;
  /**
   * Optional: word-level alternatives for a finished translation (#146).
   * Optional because it is a text-completion capability — the OCR-only
   * Apple Vision backend has nothing to answer with, and the service turns
   * its absence into a message naming the provider instead of a crash.
   */
  suggestAlternatives?(request: AlternativesRequest): Promise<AlternativesResult>;
}
