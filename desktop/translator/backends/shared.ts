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
 * Used as a fallback when language detection fails or returns garbage.
 */
export function detectLangHeuristic(text: string): "uk" | "en" {
  return /[\u0400-\u04FF]/u.test(text) ? "uk" : "en";
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

export function buildTranslateJsonPrompt(text: string, targetName: string): string {
  return (
    `You are a translation engine. Translate the user text to ${targetName}.\n` +
    `If the text is already in ${targetName}, return it unchanged.\n` +
    `Respond with ONLY a JSON object of the form ` +
    `{"sourceLang":"<ISO 639-1 code>","translation":"<translated text>"}. ` +
    `No markdown, no code fences, no commentary.\n\n` +
    `Text:\n${text}`
  );
}

export function targetLangName(targetLang: "uk" | "en"): string {
  return targetLang === "uk" ? "Ukrainian" : "English";
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
