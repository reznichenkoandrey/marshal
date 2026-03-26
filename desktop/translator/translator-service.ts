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

type ChatMessage =
  | { role: string; content: string }
  | { role: string; content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> };

export class TranslatorService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly textModel: string;
  private readonly visionModel: string;

  constructor() {
    this.apiKey = process.env.MARSHAL_API_KEY ?? "";
    this.baseUrl = (process.env.MARSHAL_API_BASE ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
    this.textModel = process.env.MARSHAL_MODEL ?? DEFAULT_TEXT_MODEL;
    this.visionModel = process.env.MARSHAL_VISION_MODEL ?? DEFAULT_VISION_MODEL;
  }

  async translateText(text: string, targetLang: TargetLang): Promise<TranslationResult> {
    if (!this.apiKey) throw new Error("MARSHAL_API_KEY is not set");
    const targetName = targetLang === "uk" ? "Ukrainian" : "English";

    const [translation, sourceLang] = await Promise.all([
      this.chat(this.textModel, [
        {
          role: "user",
          content: `Translate the following text to ${targetName}.\nReturn ONLY the translation, no explanations. If already in ${targetName}, return unchanged.\n\n${text}`
        }
      ]),
      this.detectLang(text)
    ]);

    return { translation: translation.trim(), sourceLang, targetLang };
  }

  /** Detects the source language and translates to the opposite (uk↔en). */
  async translateAuto(text: string): Promise<TranslationResult> {
    if (!this.apiKey) throw new Error("MARSHAL_API_KEY is not set");
    const sourceLang = await this.detectLang(text);
    const targetLang: TargetLang = sourceLang === "uk" ? "en" : "uk";
    const targetName = targetLang === "uk" ? "Ukrainian" : "English";
    const translation = await this.chat(this.textModel, [
      {
        role: "user",
        content: `Translate the following text to ${targetName}.\nReturn ONLY the translation, no explanations.\n\n${text}`
      }
    ]);
    return { translation: translation.trim(), sourceLang, targetLang };
  }

  async translateImage(base64: string, mimeType: string, targetLang: TargetLang): Promise<TranslationResult> {
    if (!this.apiKey) throw new Error("MARSHAL_API_KEY is not set");
    const targetName = targetLang === "uk" ? "Ukrainian" : "English";

    const translation = await this.chat(this.visionModel, [
      {
        role: "user",
        content: [
          { type: "text", text: `Extract all text from this image and translate it to ${targetName}. Return ONLY the translated text, no explanations.` },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } }
        ]
      }
    ]);

    return { translation: translation.trim(), sourceLang: "auto", targetLang };
  }

  private async detectLang(text: string): Promise<string> {
    try {
      const sample = text.slice(0, 150);
      const lang = await this.chat(this.textModel, [
        { role: "user", content: `Detect the language of this text. Reply with only the ISO 639-1 code (e.g. "en", "uk", "de"). Text: "${sample}"` }
      ]);
      return lang.trim().toLowerCase().slice(0, 2);
    } catch {
      return "auto";
    }
  }

  private async chat(model: string, messages: ChatMessage[]): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 2048 })
    });

    if (!response.ok) {
      const error = await response.text().catch(() => "Unknown error");
      throw new Error(`API error ${response.status}: ${error}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return data.choices?.[0]?.message?.content ?? "";
  }
}
