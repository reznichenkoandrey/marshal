import type { ReasoningBridge, ReasoningBridgeOptions } from "./types.ts";

type ConversationMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

const MAX_HISTORY = 50;
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * Universal OpenAI-compatible API bridge.
 * Works with any provider that implements the OpenAI chat completions API:
 *  - Groq (free, fast) — default
 *  - OpenRouter (many models)
 *  - OpenAI (GPT-4o)
 *  - Together.ai, Fireworks, etc.
 *
 * Config via env vars:
 *  MARSHAL_API_KEY     — API key for the provider
 *  MARSHAL_API_BASE    — Base URL (default: Groq)
 *  MARSHAL_MODEL       — Model name (default: llama-3.3-70b-versatile)
 */
export class OpenAiApiBridge implements ReasoningBridge {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private systemPrompt: string | null = null;
  private history: ConversationMessage[] = [];

  constructor(_options: ReasoningBridgeOptions = {}) {
    this.apiKey = process.env.MARSHAL_API_KEY ?? "";
    if (!this.apiKey) {
      throw new Error(
        "MARSHAL_API_KEY env var is required. Get a free key at https://console.groq.com"
      );
    }
    this.baseUrl = (process.env.MARSHAL_API_BASE ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = process.env.MARSHAL_MODEL ?? DEFAULT_MODEL;
  }

  async initialize(): Promise<void> { /* no-op */ }
  async openLoginWindow(): Promise<void> { /* no-op */ }

  async resetConversation(): Promise<void> {
    this.history = [];
  }

  async prime(initialPrompt: string): Promise<void> {
    this.systemPrompt = initialPrompt;
  }

  async ask(prompt: string): Promise<string> {
    this.history.push({ role: "user", content: prompt });

    const messages: ConversationMessage[] = [];
    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    messages.push(...this.history);

    const body = {
      model: this.model,
      messages,
      temperature: 0.1,
      max_tokens: 4096
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.text().catch(() => "Unknown error");
      throw new Error(`API error ${response.status}: ${error}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const text = data.choices?.[0]?.message?.content ?? "";
    this.history.push({ role: "assistant", content: text });

    // Trim history to prevent context overflow
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }

    return text;
  }

  async close(): Promise<void> {
    this.history = [];
    this.systemPrompt = null;
  }
}
