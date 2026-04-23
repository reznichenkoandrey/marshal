import Anthropic from "@anthropic-ai/sdk";

import type { TargetLang, TranslationResult, TranslatorBackend, TranslatorBackendId } from "./types.ts";
import {
  buildTranslateJsonPrompt,
  detectLangHeuristic,
  parseTranslateJson,
  targetLangName
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

  async translateText(text: string, targetLang: TargetLang): Promise<TranslationResult> {
    const prompt = buildTranslateJsonPrompt(text, targetLangName(targetLang));
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }]
    });
    const raw = this.extractText(response);
    const parsed = parseTranslateJson(raw);
    return {
      translation: parsed.translation,
      sourceLang: parsed.sourceLang || detectLangHeuristic(text),
      targetLang
    };
  }

  async translateImage(base64: string, mimeType: string, targetLang: TargetLang): Promise<TranslationResult> {
    const targetName = targetLangName(targetLang);
    const mediaType = this.normalizeMediaType(mimeType);
    const response = await this.client.messages.create({
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
            {
              type: "text",
              text:
                `Extract ALL visible text from this image and translate it to ${targetName}. ` +
                `If it is already in ${targetName}, return it unchanged. ` +
                `Output ONLY the final translated text — no commentary, no explanations, no JSON.`
            }
          ]
        }
      ]
    });

    return {
      translation: this.extractText(response).trim(),
      sourceLang: "auto",
      targetLang
    };
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
