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
import { buildSummaryMessages, type SummaryInput, type SummaryMessages } from "./summary-prompt.ts";

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
// Haiku is the latency pick on the Anthropic side for the same reason — the V3
// spec budgets < 1 s from the end of speech to the first tokens. Override with
// MARSHAL_CAPTIONS_CLAUDE_MODEL when quality matters more than that budget.
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

/** An OpenAI-compatible endpoint is reachable: a key, or a local server that needs none. */
function openAiCompatibleUsable(env: SummarizerEnv): boolean {
  const key = env.MARSHAL_CAPTIONS_API_KEY ?? env.MARSHAL_API_KEY ?? "";
  const base = env.MARSHAL_CAPTIONS_API_BASE ?? env.MARSHAL_API_BASE ?? DEFAULT_OPENAI_BASE;
  return key.length > 0 || isLocalBase(base);
}

function requestedProvider(env: SummarizerEnv): string {
  return (env.MARSHAL_CAPTIONS_PROVIDER ?? "auto").trim().toLowerCase();
}

/**
 * Which summarizer to run, from the environment alone. `auto` (the default)
 * prefers Anthropic (V3 spec §2.4, #211): a streamed Claude summary keeps the
 * captions pipeline off the OpenAI-compatible key, which on Groq shares its
 * rate limits with speech-to-text (#207). Then the OpenAI-compatible
 * endpoint, then nothing — in which case the overlay still shows raw
 * captions, just no bullets.
 */
export function resolveSummaryProvider(env: SummarizerEnv): ResolvedSummaryProvider {
  const requested = requestedProvider(env);
  const openAiUsable = openAiCompatibleUsable(env);
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
  if (claudeUsable) return { id: "claude-api", reason: "auto: ANTHROPIC_API_KEY present" };
  if (openAiUsable) return { id: "openai-api", reason: "auto: OpenAI-compatible key/base present" };
  return { id: "off", reason: "auto: no summarizer credentials — captions only" };
}

/**
 * Builds the streamer for the resolved provider.
 *
 * When `auto` picked Claude and an OpenAI-compatible endpoint is also usable,
 * Claude is wrapped with that endpoint as a fallback (#214). Having a key is
 * not the same as being able to use it — the first account this ran against
 * had an Anthropic key and no credits, and every summary failed. A provider
 * the user named explicitly is never wrapped: they chose it, so its error is
 * the thing they need to see.
 */
export function createSummaryStreamer(
  env: SummarizerEnv = process.env,
  onFallback?: (notice: SummaryFallbackNotice) => void
): SummaryStreamer | null {
  const resolved = resolveSummaryProvider(env);
  if (resolved.id === "openai-api") return new OpenAiCompatibleSummaryStreamer(env);
  if (resolved.id !== "claude-api") return null;
  const claude = new AnthropicSummaryStreamer(env);
  if (requestedProvider(env) !== "auto" || !openAiCompatibleUsable(env)) return claude;
  return new FallbackSummaryStreamer(claude, new OpenAiCompatibleSummaryStreamer(env), onFallback);
}

/** Why a provider can serve no summaries this session. */
export type SummaryUnusableReason = "auth" | "credit" | "model";

/**
 * Sorts a failed request into "this provider cannot work" or "try again".
 * Only the first kind justifies switching providers: a 429 or a 5xx is a
 * passing condition, and switching on it would abandon a working key.
 *
 * Detection is by status and message rather than `instanceof`, as in the
 * translator (#160): the error classes differ between the SDK and the fetch
 * path, and have moved between SDK majors before.
 */
export function classifySummaryError(err: unknown): SummaryUnusableReason | null {
  if (!err || typeof err !== "object") return null;
  const status = (err as { status?: unknown }).status;
  const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? "");
  if (status === 401 || status === 403) return "auth";
  // Anthropic reports an empty balance as a 400 invalid_request_error; only
  // the message tells it apart from a malformed request.
  if (status === 400 && /credit balance/iu.test(message)) return "credit";
  if (status === 404 && /model|not_found/iu.test(message)) return "model";
  return null;
}

export interface SummaryFallbackNotice {
  from: SummaryProviderId;
  to: SummaryProviderId;
  reason: SummaryUnusableReason;
}

/**
 * Primary streamer with a fallback for when the primary turns out unusable.
 *
 * The switch is sticky for the session: once the primary has said "no
 * credits", asking again before every summary would add a doomed round trip
 * to each one. And it only happens before any text was shown — a request
 * that already streamed words and then failed is not re-run, because the
 * retry would put a second copy of the same bullets on screen.
 */
export class FallbackSummaryStreamer implements SummaryStreamer {
  private active: SummaryStreamer;

  constructor(
    private readonly primary: SummaryStreamer,
    private readonly fallback: SummaryStreamer,
    private readonly onFallback?: (notice: SummaryFallbackNotice) => void
  ) {
    this.active = primary;
  }

  /** The provider currently answering — changes once, on fallback. */
  get id(): SummaryProviderId {
    return this.active.id;
  }

  async stream(input: SummaryInput, onDelta: (delta: string) => void, signal: AbortSignal): Promise<string> {
    if (this.active === this.fallback) return this.fallback.stream(input, onDelta, signal);

    let streamedAnything = false;
    try {
      return await this.primary.stream(
        input,
        (delta) => {
          streamedAnything = true;
          onDelta(delta);
        },
        signal
      );
    } catch (err) {
      const reason = classifySummaryError(err);
      if (reason === null || streamedAnything || signal.aborted) throw err;
      this.active = this.fallback;
      this.onFallback?.({ from: this.primary.id, to: this.fallback.id, reason });
      return this.fallback.stream(input, onDelta, signal);
    }
  }
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
      throw Object.assign(new Error(`summarizer ${response.status} ${response.statusText}: ${detail.slice(0, 300)}`), {
        status: response.status
      });
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

/**
 * Anthropic system blocks: the instructions, then the reference block with a
 * cache breakpoint — it is identical on every request until a file changes,
 * so it is served from cache instead of re-billed each summary.
 */
export function buildAnthropicSystem(messages: SummaryMessages): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [{ type: "text", text: messages.systemInstructions }];
  if (messages.referenceContext.length > 0) {
    blocks.push({ type: "text", text: messages.referenceContext, cache_control: { type: "ephemeral" } });
  }
  return blocks;
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
        system: buildAnthropicSystem(messages),
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
