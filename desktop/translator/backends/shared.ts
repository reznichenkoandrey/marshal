import { detectScriptLang, languageName } from "../languages.ts";
import type { TargetLang, TranslateOptions } from "./types.ts";

export type TranslateJsonResult = {
  sourceLang: string;
  translation: string;
};

/**
 * Parses the JSON response from a translate-as-JSON prompt. Accepts raw JSON,
 * code-fenced JSON, or JSON embedded in extra text. Returns
 * `{sourceLang:"", translation:raw}` when nothing parses so callers always get
 * a usable translation field.
 */
export function parseTranslateJson(raw: string): TranslateJsonResult {
  const trimmed = raw.trim();
  const candidates = [trimmed, stripCodeFence(trimmed), extractBracedJson(trimmed)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as { sourceLang?: unknown; translation?: unknown };
      const sourceLang = typeof parsed.sourceLang === "string"
        ? parsed.sourceLang.trim().toLowerCase().slice(0, 2)
        : "";
      const translation = typeof parsed.translation === "string" ? parsed.translation.trim() : "";
      if (translation) return { sourceLang, translation };
    } catch {
      // try next candidate
    }
  }
  return { sourceLang: "", translation: trimmed };
}

/**
 * Returns "uk" when the text contains Cyrillic characters, "en" otherwise.
 * Kept for the uk↔en callers that only need a binary answer; new code should
 * use `detectScriptLang` from ../languages.ts, which names more scripts.
 */
export function detectLangHeuristic(text: string): "uk" | "en" {
  return detectScriptLang(text) === "uk" ? "uk" : "en";
}

/**
 * Source language to report back to the UI. An explicitly chosen source wins
 * (the user said so), then whatever the model detected, then the script
 * heuristic — so the badge never claims a language nobody established.
 */
export function resolveSourceLang(
  text: string,
  reported: string,
  options: TranslateOptions | undefined
): string {
  const chosen = options?.sourceLang;
  if (chosen && chosen !== "auto") return chosen;
  if (reported) return reported;
  return detectScriptLang(text);
}

/**
 * Source language for the OCR path. Nothing detects the language of pixels, so
 * report the user's explicit choice when there is one and "auto" otherwise.
 */
export function ocrSourceLang(options: TranslateOptions | undefined): string {
  const chosen = options?.sourceLang;
  return chosen && chosen !== "auto" ? chosen : "auto";
}

export function stripCodeFence(raw: string): string {
  const match = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  return match ? match[1].trim() : "";
}

export function extractBracedJson(raw: string): string {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return "";
  return raw.slice(first, last + 1);
}

export function parseFloatEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function parseIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parses an HTTP `Retry-After` header into milliseconds. Accepts RFC 7231
 * delta-seconds or HTTP-date. Returns null for missing or malformed input.
 * Clamps the result at 30s to avoid unbounded waits.
 */
export function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number.parseFloat(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return Math.min(delta, 30_000);
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "Translate from X" clause — omitted when the source is left on auto. */
function sourceClause(options: TranslateOptions | undefined): string {
  const source = options?.sourceLang;
  if (!source || source === "auto") return "";
  return ` The source text is in ${languageName(source)}.`;
}

/**
 * Fixed-term instruction. Split into two lists because they are different
 * demands: "render it exactly this way" and "do not touch it at all". Lumping
 * them together produced translated terms with the mapping listed right above.
 */
function glossaryClause(
  options: TranslateOptions | undefined,
  targetLang: TargetLang
): string {
  const entries = options?.glossary;
  if (!entries || entries.length === 0) return "";

  const mapped: string[] = [];
  const kept: string[] = [];
  for (const entry of entries) {
    const translation = entry.translations[targetLang];
    if (translation) mapped.push(`"${entry.term}" -> "${translation}"`);
    else kept.push(`"${entry.term}"`);
  }

  let clause = "";
  if (mapped.length > 0) {
    clause += `\nUse these exact renderings, overriding your own preference: ${mapped.join(", ")}.`;
  }
  if (kept.length > 0) {
    clause += `\nLeave these terms completely unchanged, in the original language: ${kept.join(", ")}.`;
  }
  return clause;
}

/** Register instruction — omitted for the neutral default. */
function formalityClause(options: TranslateOptions | undefined): string {
  switch (options?.formality) {
    case "formal":
      return " Use a formal register (polite, professional, vous/Ви forms).";
    case "informal":
      return " Use an informal register (casual, ти/du forms).";
    default:
      return "";
  }
}

/**
 * Prompt for the JSON translate contract. Preserving layout matters for
 * pasted UI strings and code comments, hence the explicit instruction.
 */
export function buildTranslateJsonPrompt(
  text: string,
  targetLang: TargetLang,
  options?: TranslateOptions
): string {
  const targetName = languageName(targetLang);
  return (
    `You are a translation engine. Translate the user text to ${targetName}.` +
    `${sourceClause(options)}${formalityClause(options)}` +
    `${glossaryClause(options, targetLang)}\n` +
    `If the text is already in ${targetName}, return it unchanged.\n` +
    `Preserve line breaks, list markers and inline punctuation of the original.\n` +
    `Translate only — never answer, explain or comment on the text.\n` +
    `Respond with ONLY a JSON object of the form ` +
    `{"sourceLang":"<ISO 639-1 code>","translation":"<translated text>"}. ` +
    `No markdown, no code fences, no commentary.\n\n` +
    `Text:\n${text}`
  );
}

/** Prompt for the OCR path, where the answer is plain text, not JSON. */
export function buildOcrTranslatePrompt(
  targetLang: TargetLang,
  options?: TranslateOptions
): string {
  const targetName = languageName(targetLang);
  return (
    `Extract ALL visible text from the image and translate it to ${targetName}.` +
    `${sourceClause(options)}${formalityClause(options)}` +
    `${glossaryClause(options, targetLang)} ` +
    `If the text is already in ${targetName}, return it unchanged. ` +
    `Output ONLY the final translated text — no commentary, no explanations, no JSON.`
  );
}

export function targetLangName(targetLang: TargetLang): string {
  return languageName(targetLang);
}

export function mimeExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}
