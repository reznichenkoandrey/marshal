// desktop/translator/languages.ts
//
// Single source of truth for the language set the translator offers. The main
// process imports it directly; the renderer receives the same array over IPC
// (`marshal:translator-languages`) so the picker never drifts from the
// prompts the backends build.
//
// Codes are ISO 639-1, which is also what the backends are asked to report in
// `sourceLang`, so a detected code can be looked up here without mapping.

export interface LanguageEntry {
  /** ISO 639-1 code. */
  readonly code: LangCode;
  /** English name — what the prompt sends to the model. */
  readonly name: string;
  /** Endonym — what the picker shows as a subtitle. */
  readonly native: string;
}

export type LangCode =
  | "ar" | "az" | "be" | "bg" | "ca" | "cs" | "da" | "de" | "el" | "en"
  | "es" | "et" | "fa" | "fi" | "fr" | "he" | "hi" | "hr" | "hu" | "id"
  | "it" | "ja" | "ka" | "kk" | "ko" | "lt" | "lv" | "nb" | "nl" | "pl"
  | "pt" | "ro" | "ru" | "sk" | "sl" | "sr" | "sv" | "th" | "tr" | "uk"
  | "vi" | "zh";

/** Source side of the pair — may defer detection to the model. */
export type SourceLang = LangCode | "auto";

export const LANGUAGES: readonly LanguageEntry[] = [
  { code: "ar", name: "Arabic", native: "العربية" },
  { code: "az", name: "Azerbaijani", native: "Azərbaycan" },
  { code: "be", name: "Belarusian", native: "Беларуская" },
  { code: "bg", name: "Bulgarian", native: "Български" },
  { code: "ca", name: "Catalan", native: "Català" },
  { code: "zh", name: "Chinese", native: "中文" },
  { code: "hr", name: "Croatian", native: "Hrvatski" },
  { code: "cs", name: "Czech", native: "Čeština" },
  { code: "da", name: "Danish", native: "Dansk" },
  { code: "nl", name: "Dutch", native: "Nederlands" },
  { code: "en", name: "English", native: "English" },
  { code: "et", name: "Estonian", native: "Eesti" },
  { code: "fi", name: "Finnish", native: "Suomi" },
  { code: "fr", name: "French", native: "Français" },
  { code: "ka", name: "Georgian", native: "ქართული" },
  { code: "de", name: "German", native: "Deutsch" },
  { code: "el", name: "Greek", native: "Ελληνικά" },
  { code: "he", name: "Hebrew", native: "עברית" },
  { code: "hi", name: "Hindi", native: "हिन्दी" },
  { code: "hu", name: "Hungarian", native: "Magyar" },
  { code: "id", name: "Indonesian", native: "Indonesia" },
  { code: "it", name: "Italian", native: "Italiano" },
  { code: "ja", name: "Japanese", native: "日本語" },
  { code: "kk", name: "Kazakh", native: "Қазақша" },
  { code: "ko", name: "Korean", native: "한국어" },
  { code: "lv", name: "Latvian", native: "Latviešu" },
  { code: "lt", name: "Lithuanian", native: "Lietuvių" },
  { code: "nb", name: "Norwegian", native: "Norsk bokmål" },
  { code: "fa", name: "Persian", native: "فارسی" },
  { code: "pl", name: "Polish", native: "Polski" },
  { code: "pt", name: "Portuguese", native: "Português" },
  { code: "ro", name: "Romanian", native: "Română" },
  { code: "ru", name: "Russian", native: "Русский" },
  { code: "sr", name: "Serbian", native: "Српски" },
  { code: "sk", name: "Slovak", native: "Slovenčina" },
  { code: "sl", name: "Slovenian", native: "Slovenščina" },
  { code: "es", name: "Spanish", native: "Español" },
  { code: "sv", name: "Swedish", native: "Svenska" },
  { code: "th", name: "Thai", native: "ไทย" },
  { code: "tr", name: "Turkish", native: "Türkçe" },
  { code: "uk", name: "Ukrainian", native: "Українська" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt" }
];

const BY_CODE = new Map<string, LanguageEntry>(LANGUAGES.map((entry) => [entry.code, entry]));

export function isLangCode(value: unknown): value is LangCode {
  return typeof value === "string" && BY_CODE.has(value);
}

export function isSourceLang(value: unknown): value is SourceLang {
  return value === "auto" || isLangCode(value);
}

/**
 * Normalizes whatever a settings file or a model response carries into a known
 * code. Accepts locale-ish input ("en-GB", "ZH_Hans", "nb-NO") by taking the
 * primary subtag. Falls back when nothing matches.
 */
export function resolveLangCode<T extends LangCode>(raw: unknown, fallback: T): LangCode | T {
  if (typeof raw !== "string") return fallback;
  const primary = raw.trim().toLowerCase().split(/[-_]/u)[0];
  return isLangCode(primary) ? primary : fallback;
}

export function resolveSourceLang(raw: unknown, fallback: SourceLang): SourceLang {
  if (typeof raw !== "string") return fallback;
  const candidate = raw.trim().toLowerCase();
  if (candidate === "auto" || candidate === "") return candidate === "auto" ? "auto" : fallback;
  const primary = candidate.split(/[-_]/u)[0];
  return isLangCode(primary) ? primary : fallback;
}

/** English name for a code — this is what the prompts say. */
export function languageName(code: string): string {
  return BY_CODE.get(code)?.name ?? code.toUpperCase();
}

/** Endonym, for UI only. */
export function languageNative(code: string): string {
  return BY_CODE.get(code)?.native ?? code.toUpperCase();
}

// Script ranges that identify a language unambiguously enough for picking a
// translation direction without a model round trip. Latin-script languages
// are indistinguishable this way, so they all collapse into "en" — the
// direction logic only needs to know "is this already the target".
const SCRIPT_PROBES: ReadonlyArray<{ readonly pattern: RegExp; readonly code: LangCode }> = [
  { pattern: /[Ѐ-ӿ]/u, code: "uk" },
  { pattern: /[֐-׿]/u, code: "he" },
  { pattern: /[؀-ۿ]/u, code: "ar" },
  { pattern: /[ऀ-ॿ]/u, code: "hi" },
  { pattern: /[฀-๿]/u, code: "th" },
  { pattern: /[Ⴀ-ჿ]/u, code: "ka" },
  { pattern: /[Ͱ-Ͽ]/u, code: "el" },
  { pattern: /[぀-ヿ]/u, code: "ja" },
  { pattern: /[가-힯]/u, code: "ko" },
  { pattern: /[一-鿿]/u, code: "zh" }
];

/**
 * Best-effort source language from the script alone. Used to pick a direction
 * for the auto-translate hotkey before any model call — deterministic, and it
 * still works when the backend later fails.
 */
export function detectScriptLang(text: string): LangCode {
  for (const probe of SCRIPT_PROBES) {
    if (probe.pattern.test(text)) return probe.code;
  }
  return "en";
}
