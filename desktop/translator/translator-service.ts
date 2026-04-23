// desktop/translator/translator-service.ts
// OpenAI-compatible translation service using MARSHAL_API_KEY

export type TargetLang = "uk" | "en";

export interface TranslationResult {
  translation: string;
  sourceLang: string;
  targetLang: TargetLang;
}

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_TEXT_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_RETRIES = 3;

type ChatMessage =
  | { role: string; content: string }
  | { role: string; content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> };

type ChatOptions = {
  json?: boolean;
  maxTokens?: number;
};

export class TranslatorService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly textModel: string;
  private readonly visionModel: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly maxRetries: number;

  constructor() {
    this.apiKey = process.env.MARSHAL_API_KEY ?? "";
    this.baseUrl = (process.env.MARSHAL_API_BASE ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
    this.textModel = process.env.MARSHAL_MODEL ?? DEFAULT_TEXT_MODEL;
    this.visionModel = process.env.MARSHAL_VISION_MODEL ?? DEFAULT_VISION_MODEL;
    this.temperature = parseFloatEnv("MARSHAL_TRANSLATOR_TEMPERATURE", DEFAULT_TEMPERATURE);
    this.maxTokens = parseIntEnv("MARSHAL_TRANSLATOR_MAX_TOKENS", DEFAULT_MAX_TOKENS);
    this.maxRetries = parseIntEnv("MARSHAL_TRANSLATOR_MAX_RETRIES", DEFAULT_MAX_RETRIES);
  }

  async translateText(text: string, targetLang: TargetLang): Promise<TranslationResult> {
    if (!this.apiKey) throw new Error("MARSHAL_API_KEY is not set");

    const result = await this.translateJson(text, targetLang);
    return {
      translation: result.translation,
      sourceLang: result.sourceLang || this.detectLangHeuristic(text),
      targetLang
    };
  }

  /** Detects the source language and translates to the opposite (uk↔en). */
  async translateAuto(text: string): Promise<TranslationResult> {
    if (!this.apiKey) throw new Error("MARSHAL_API_KEY is not set");

    // Heuristic picks translation direction up-front. A Cyrillic sample is
    // Ukrainian (or near enough for this feature); everything else targets
    // Ukrainian. This removes the extra detect-language round trip and makes
    // direction decisions deterministic even when the API call later fails.
    const heuristic = this.detectLangHeuristic(text);
    const targetLang: TargetLang = heuristic === "uk" ? "en" : "uk";
    const result = await this.translateJson(text, targetLang);
    return {
      translation: result.translation,
      sourceLang: result.sourceLang || heuristic,
      targetLang
    };
  }

  async translateImage(base64: string, mimeType: string, targetLang: TargetLang): Promise<TranslationResult> {
    if (!this.apiKey) throw new Error("MARSHAL_API_KEY is not set");
    const targetName = targetLang === "uk" ? "Ukrainian" : "English";

    const translation = await this.chat(this.visionModel, [
      {
        role: "user",
        content: [
          { type: "text", text: `Extract ALL visible text from this image. Translate the extracted text to ${targetName}. If it is already in ${targetName}, return the original text unchanged. Output ONLY the final text — no comments, no explanations, no phrases like "there is no text".` },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } }
        ]
      }
    ]);

    return { translation: translation.trim(), sourceLang: "auto", targetLang };
  }

  /**
   * Merged detect-language + translate in a single chat completion so a text
   * translation only costs one API call instead of two.
   */
  private async translateJson(text: string, targetLang: TargetLang): Promise<TranslateJsonResult> {
    const targetName = targetLang === "uk" ? "Ukrainian" : "English";
    const prompt =
      `You are a translation engine. Translate the user text to ${targetName}.\n` +
      `If the text is already in ${targetName}, return it unchanged.\n` +
      `Respond with ONLY a JSON object of the form ` +
      `{"sourceLang":"<ISO 639-1 code>","translation":"<translated text>"}. ` +
      `No markdown, no code fences, no commentary.\n\n` +
      `Text:\n${text}`;

    const raw = await this.chat(this.textModel, [{ role: "user", content: prompt }], { json: true });
    return this.parseTranslateJson(raw);
  }

  private parseTranslateJson(raw: string): TranslateJsonResult {
    return parseTranslateJson(raw);
  }

  private detectLangHeuristic(text: string): "uk" | "en" {
    return detectLangHeuristic(text);
  }

  private async chat(model: string, messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: this.temperature,
      max_tokens: options.maxTokens ?? this.maxTokens
    };
    if (options.json) {
      body.response_format = { type: "json_object" };
    }

    // Retry on rate-limit (429) and transient 5xx responses with exponential
    // backoff. Honour `Retry-After` when present.
    let lastError: Error = new Error("No request attempted");
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return data.choices?.[0]?.message?.content ?? "";
      }

      const status = response.status;
      const errorText = await response.text().catch(() => "Unknown error");
      lastError = new Error(`API error ${status}: ${errorText}`);

      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === this.maxRetries) break;

      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
      const backoffMs = retryAfterMs ?? Math.min(1000 * 2 ** attempt, 8000);
      await sleep(backoffMs);
    }
    throw lastError;
  }
}

export type TranslateJsonResult = {
  sourceLang: string;
  translation: string;
};

/**
 * Parses the JSON response from `translateJson()`. Accepts raw JSON, code-fenced
 * JSON, or JSON embedded in extra text. Returns `{sourceLang:"", translation:raw}`
 * when nothing parses so callers always get a usable translation field.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
