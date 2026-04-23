export type TargetLang = "uk" | "en";

export type TranslatorBackendId = "groq" | "claude-cli" | "codex-cli";

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
