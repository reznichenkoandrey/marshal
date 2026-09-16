import Anthropic from "@anthropic-ai/sdk";

import { TranslatorAuthError, isAuthStatus } from "./errors.ts";
import type {
  TargetLang,
  TranslateOptions,
  TranslationResult,
  TranslatorBackend,
  TranslatorBackendId
} from "./types.ts";
import {
  buildOcrTranslatePrompt,
  buildTranslateJsonPrompt,
  ocrSourceLang,
  parseTranslateJson,
  resolveSourceLang
} from "./shared.ts";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 1024;

/**
 * Translator backend that calls the Anthropic Messages API directly using
 * `ANTHROPIC_API_KEY`. Used when the user selected the "Anthropic API" provider
 * in Settings — billing is pay-per-token instead of the OAuth subscription.
 */
export class ClaudeApiTranslatorBackend implements TranslatorBackend {
  readonly id: TranslatorBackendId = "claude-api";

  private readonly client: Anthropic;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Claude API translator backend requires ANTHROPIC_API_KEY. " +
        "Set it in the Marshal .env file or switch to Claude CLI / Codex CLI in Settings."
      );
    }
    this.client = new Anthropic({ apiKey });
    this.model = process.env.MARSHAL_CLAUDE_MODEL ?? process.env.MARSHAL_MODEL ?? DEFAULT_MODEL;
  }

  async translateText(text: string, targetLang: TargetLang, options?: TranslateOptions): Promise<TranslationResult> {
    const prompt = buildTranslateJsonPrompt(text, targetLang, options);
    const response = await this.send({
      model: this.model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }]
    });
    const raw = this.extractText(response);
    const parsed = parseTranslateJson(raw);
    return {
      translation: parsed.translation,
      sourceLang: resolveSourceLang(text, parsed.sourceLang, options),
      targetLang
    };
  }

  async translateImage(
    base64: string,
    mimeType: string,
    targetLang: TargetLang,
    options?: TranslateOptions
  ): Promise<TranslationResult> {
    const mediaType = this.normalizeMediaType(mimeType);
    const response = await this.send({
      model: this.model,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 }
            },
            { type: "text", text: buildOcrTranslatePrompt(targetLang, options) }
          ]
        }
      ]
    });

    return {
      translation: this.extractText(response).trim(),
      sourceLang: ocrSourceLang(options),
      targetLang
    };
  }

  /**
   * Single exit to the SDK, so a rejected credential comes back as a
   * TranslatorAuthError from every call path. Detection is by status rather
   * than `instanceof` — the service must not have to import the SDK, and the
   * class names have moved between SDK majors before. See #160.
   */
  private async send(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create(body);
    } catch (err) {
      if (err && typeof err === "object" && isAuthStatus((err as { status?: unknown }).status)) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new TranslatorAuthError(this.id, (err as { status: number }).status, detail.slice(0, 200));
      }
      throw err;
    }
  }

  private extractText(response: Anthropic.Message): string {
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  private normalizeMediaType(
    mime: string
  ): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
    switch (mime) {
      case "image/jpeg":
      case "image/jpg":
        return "image/jpeg";
      case "image/gif":
        return "image/gif";
      case "image/webp":
        return "image/webp";
      default:
        return "image/png";
    }
  }
}
