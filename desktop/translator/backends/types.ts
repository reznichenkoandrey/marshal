export type TargetLang = "uk" | "en";

/**
 * Concrete translator backends. `groq` is kept as a legacy alias for
 * `openai-api` so existing settings files keep working after the rename.
 */
export type TranslatorBackendId =
  | "claude-cli"
  | "codex-cli"
  | "claude-api"
  | "openai-api"
  | "groq";

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
  translateText(text: string, targetLang: TargetLang): Promise<TranslationResult>;
  translateImage(base64: string, mimeType: string, targetLang: TargetLang): Promise<TranslationResult>;
}
