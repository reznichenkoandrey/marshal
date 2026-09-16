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

export interface TranslatorBackend {
  readonly id: TranslatorBackendId;
  translateText(text: string, targetLang: TargetLang, options?: TranslateOptions): Promise<TranslationResult>;
  translateImage(
    base64: string,
    mimeType: string,
    targetLang: TargetLang,
    options?: TranslateOptions
  ): Promise<TranslationResult>;
}
