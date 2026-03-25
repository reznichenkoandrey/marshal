import Anthropic from "@anthropic-ai/sdk";
import type { ReasoningBridge, ReasoningBridgeOptions } from "./types.ts";

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

const MAX_HISTORY_LENGTH = 100;
const TRIM_TO_LENGTH = 80;
const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 4096;

export class ClaudeApiBridge implements ReasoningBridge {
  private client: Anthropic;
  private model: string;
  private systemPrompt: string | null = null;
  private history: ConversationMessage[] = [];

  constructor(_options: ReasoningBridgeOptions = {}) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY env var is required for claude bridge mode. Set it in .env or export it."
      );
    }
    this.client = new Anthropic({ apiKey });
    this.model = process.env.MARSHAL_MODEL ?? DEFAULT_MODEL;
  }

  async initialize(): Promise<void> {
    // No-op: API key is validated in constructor
  }

  async openLoginWindow(): Promise<void> {
    // No-op: API key is the only credential
  }

  async resetConversation(): Promise<void> {
    this.history = [];
    this.systemPrompt = null;
  }

  async prime(initialPrompt: string): Promise<void> {
    // Store system prompt — it will be passed as the `system` parameter
    // on every messages.create() call (idiomatic Anthropic API pattern)
    this.systemPrompt = initialPrompt;
  }

  async ask(prompt: string): Promise<string> {
    this.history.push({ role: "user", content: prompt });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: this.systemPrompt ?? undefined,
      messages: this.history
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    this.history.push({ role: "assistant", content: text });

    // Prevent context window overflow on long tasks
    if (this.history.length > MAX_HISTORY_LENGTH) {
      this.history = this.history.slice(-TRIM_TO_LENGTH);
    }

    return text;
  }

  async close(): Promise<void> {
    this.history = [];
    this.systemPrompt = null;
  }
}
