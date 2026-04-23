import type { TargetLang, TranslationResult, TranslatorBackend, TranslatorBackendId } from "./types.ts";
import {
  buildTranslateJsonPrompt,
  detectLangHeuristic,
  parseFloatEnv,
  parseIntEnv,
  parseRetryAfterMs,
  parseTranslateJson,
  sleep,
  targetLangName
} from "./shared.ts";

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_TEXT_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_RETRIES = 3;

type ChatMessage =
  | { role: string; content: string }
  | {
      role: string;
      content: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
    };

type ChatOptions = {
  json?: boolean;
  maxTokens?: number;
};

/**
 * Groq-hosted OpenAI-compatible translator backend. Fastest and cheapest of
 * the three, but requires an explicit API key (`MARSHAL_API_KEY`). Kept as an
 * opt-in choice; the default backend is `claude-cli` so that users on a Claude
 * Pro/Max subscription translate without any extra keys.
 */
export class GroqTranslatorBackend implements TranslatorBackend {
  readonly id: TranslatorBackendId = "groq";

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
    if (!this.apiKey) throw new Error("Groq backend: MARSHAL_API_KEY is not set");
    const prompt = buildTranslateJsonPrompt(text, targetLangName(targetLang));
    const raw = await this.chat(this.textModel, [{ role: "user", content: prompt }], { json: true });
    const result = parseTranslateJson(raw);
    return {
      translation: result.translation,
      sourceLang: result.sourceLang || detectLangHeuristic(text),
      targetLang
    };
  }

  async translateImage(base64: string, mimeType: string, targetLang: TargetLang): Promise<TranslationResult> {
    if (!this.apiKey) throw new Error("Groq backend: MARSHAL_API_KEY is not set");
    const targetName = targetLangName(targetLang);

    const translation = await this.chat(this.visionModel, [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Extract ALL visible text from this image. Translate the extracted text to ${targetName}. ` +
              `If it is already in ${targetName}, return the original text unchanged. ` +
              `Output ONLY the final text — no comments, no explanations, no phrases like "there is no text".`
          },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } }
        ]
      }
    ]);

    return { translation: translation.trim(), sourceLang: "auto", targetLang };
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
      lastError = new Error(`Groq API error ${status}: ${errorText}`);

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
