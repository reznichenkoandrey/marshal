// desktop/captions/summarizer.ts
//
// Streaming "accessibility summarizer" behind the captions overlay. Two
// transports: any OpenAI-compatible chat endpoint (Groq by default, also
// OpenRouter / OpenAI / a local Ollama at http://127.0.0.1:11434/v1) and the
// Anthropic Messages API. Both stream, because the whole point of the overlay
// is that the first words land before the model has finished thinking.
//
// The translator backends are deliberately not reused here: they return one
// JSON blob per call and are tuned for fidelity, while this needs token
// deltas and a short, lossy answer.

import Anthropic from "@anthropic-ai/sdk";

import { OpenAiSseParser } from "./sse.ts";
import { buildSummaryMessages, type SummaryInput } from "./summary-prompt.ts";

export type SummaryProviderId = "openai-api" | "claude-api" | "off";

export interface SummaryStreamer {
  readonly id: SummaryProviderId;
  /** Streams deltas to `onDelta`; resolves with the full text. Aborts via `signal`. */
  stream(input: SummaryInput, onDelta: (delta: string) => void, signal: AbortSignal): Promise<string>;
}

export interface SummarizerEnv {
  MARSHAL_CAPTIONS_PROVIDER?: string;
  MARSHAL_CAPTIONS_API_KEY?: string;
  MARSHAL_CAPTIONS_API_BASE?: string;
  MARSHAL_CAPTIONS_MODEL?: string;
  MARSHAL_API_KEY?: string;
  MARSHAL_API_BASE?: string;
  MARSHAL_TRANSLATOR_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  MARSHAL_CAPTIONS_CLAUDE_MODEL?: string;
}

const DEFAULT_OPENAI_BASE = "https://api.groq.com/openai/v1";
// Same reasoning as the translator (#155): a summary that must land in under
// a second wants the fastest model the account serves, not the smartest.
const DEFAULT_OPENAI_MODEL = "qwen/qwen3.8-27b";
// Haiku is the latency pick on the Anthropic side for the same reason; override
// with MARSHAL_CAPTIONS_CLAUDE_MODEL when quality matters more than the 2.5 s
// budget from the spec.
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 256;
const TEMPERATURE = 0.2;

export interface ResolvedSummaryProvider {
  id: SummaryProviderId;
  /** Human-readable reason, surfaced in logs and the overlay hint. */
  reason: string;
}

function isLocalBase(base: string): boolean {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?/iu.test(base);
}

/**
 * Which summarizer to run, from the environment alone. `auto` (the default)
 * prefers the OpenAI-compatible key because that is what the rest of Marshal
 * already uses for speed-critical work, then Anthropic, then nothing — in
 * which case the overlay still shows raw captions, just no bullets.
 */
export function resolveSummaryProvider(env: SummarizerEnv): ResolvedSummaryProvider {
  const requested = (env.MARSHAL_CAPTIONS_PROVIDER ?? "auto").trim().toLowerCase();
  const openAiKey = env.MARSHAL_CAPTIONS_API_KEY ?? env.MARSHAL_API_KEY ?? "";
  const openAiBase = env.MARSHAL_CAPTIONS_API_BASE ?? env.MARSHAL_API_BASE ?? DEFAULT_OPENAI_BASE;
  const openAiUsable = openAiKey.length > 0 || isLocalBase(openAiBase);
  const claudeUsable = (env.ANTHROPIC_API_KEY ?? "").length > 0;

  if (requested === "off" || requested === "none") {
    return { id: "off", reason: "MARSHAL_CAPTIONS_PROVIDER=off" };
  }
  if (requested === "openai-api" || requested === "groq" || requested === "ollama") {
    return openAiUsable
      ? { id: "openai-api", reason: `MARSHAL_CAPTIONS_PROVIDER=${requested}` }
      : { id: "off", reason: `${requested} requested but no MARSHAL_API_KEY and base is not local` };
  }
  if (requested === "claude-api" || requested === "anthropic") {
    return claudeUsable
      ? { id: "claude-api", reason: `MARSHAL_CAPTIONS_PROVIDER=${requested}` }
      : { id: "off", reason: `${requested} requested but ANTHROPIC_API_KEY is empty` };
  }
  if (openAiUsable) return { id: "openai-api", reason: "auto: OpenAI-compatible key/base present" };
  if (claudeUsable) return { id: "claude-api", reason: "auto: ANTHROPIC_API_KEY present" };
  return { id: "off", reason: "auto: no summarizer credentials — captions only" };
}

export function createSummaryStreamer(env: SummarizerEnv = process.env): SummaryStreamer | null {
  const resolved = resolveSummaryProvider(env);
  if (resolved.id === "openai-api") return new OpenAiCompatibleSummaryStreamer(env);
  if (resolved.id === "claude-api") return new AnthropicSummaryStreamer(env);
  return null;
}

export class OpenAiCompatibleSummaryStreamer implements SummaryStreamer {
  readonly id: SummaryProviderId = "openai-api";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(env: SummarizerEnv) {
    this.apiKey = env.MARSHAL_CAPTIONS_API_KEY ?? env.MARSHAL_API_KEY ?? "";
    this.baseUrl = (env.MARSHAL_CAPTIONS_API_BASE ?? env.MARSHAL_API_BASE ?? DEFAULT_OPENAI_BASE).replace(/\/+$/u, "");
    this.model = env.MARSHAL_CAPTIONS_MODEL ?? env.MARSHAL_TRANSLATOR_MODEL ?? DEFAULT_OPENAI_MODEL;
  }

  async stream(input: SummaryInput, onDelta: (delta: string) => void, signal: AbortSignal): Promise<string> {
    const messages = buildSummaryMessages(input);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey.length > 0) headers.Authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: this.model,
        stream: true,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user }
        ]
      })
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`summarizer ${response.status} ${response.statusText}: ${detail.slice(0, 300)}`);
    }

    const parser = new OpenAiSseParser();
    const decoder = new TextDecoder();
    let full = "";
    const reader = response.body.getReader();
    try {
      while (!parser.done) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const delta of parser.push(decoder.decode(value, { stream: true }))) {
          full += delta;
          onDelta(delta);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return full;
  }
}

export class AnthropicSummaryStreamer implements SummaryStreamer {
  readonly id: SummaryProviderId = "claude-api";
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(env: SummarizerEnv) {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    this.model = env.MARSHAL_CAPTIONS_CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL;
  }

  async stream(input: SummaryInput, onDelta: (delta: string) => void, signal: AbortSignal): Promise<string> {
    const messages = buildSummaryMessages(input);
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: messages.system,
        messages: [{ role: "user", content: messages.user }]
      },
      { signal }
    );
    stream.on("text", (delta) => onDelta(delta));
    const final = await stream.finalMessage();
    return final.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
}
