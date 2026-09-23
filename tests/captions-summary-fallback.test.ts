// tests/captions-summary-fallback.test.ts
//
// #214: `auto` picks Claude whenever ANTHROPIC_API_KEY is set (#213), but a
// key is not the same as a usable one — the first account this ran against
// had no credits and every summary failed. These pin down when the summary
// switches to the OpenAI-compatible provider, and, just as important, when it
// must not.

import { describe, expect, it, vi } from "vitest";

import {
  AnthropicSummaryStreamer,
  classifySummaryError,
  createSummaryStreamer,
  FallbackSummaryStreamer,
  OpenAiCompatibleSummaryStreamer,
  type SummaryFallbackNotice,
  type SummaryProviderId,
  type SummaryStreamer
} from "../desktop/captions/summarizer.ts";
import type { SummaryInput } from "../desktop/captions/summary-prompt.ts";

const INPUT: SummaryInput = { transcript: "We move billing to Kafka.", ocrContext: "", outputLanguage: "" };

/** The shape the Anthropic SDK and the fetch path both throw: an Error with a status. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const NO_CREDITS = httpError(
  400,
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'
);

class FakeStreamer implements SummaryStreamer {
  calls = 0;
  constructor(
    readonly id: SummaryProviderId,
    private readonly behaviour: (onDelta: (delta: string) => void) => Promise<string>
  ) {}

  async stream(_input: SummaryInput, onDelta: (delta: string) => void): Promise<string> {
    this.calls += 1;
    return this.behaviour(onDelta);
  }
}

const answers = (text: string) => async (onDelta: (delta: string) => void): Promise<string> => {
  onDelta(text);
  return text;
};
const fails = (err: Error) => async (): Promise<string> => {
  throw err;
};

describe("classifySummaryError", () => {
  it("treats a refused key, an empty balance and a missing model as unusable", () => {
    expect(classifySummaryError(httpError(401, "invalid x-api-key"))).toBe("auth");
    expect(classifySummaryError(httpError(403, "permission denied"))).toBe("auth");
    expect(classifySummaryError(NO_CREDITS)).toBe("credit");
    expect(classifySummaryError(httpError(404, '{"type":"not_found_error","message":"model: claude-x"}'))).toBe("model");
  });

  it("does not give up on a provider over a passing condition", () => {
    expect(classifySummaryError(httpError(429, "rate limited"))).toBeNull();
    expect(classifySummaryError(httpError(529, "overloaded"))).toBeNull();
    expect(classifySummaryError(httpError(500, "internal"))).toBeNull();
    // A 400 that is a real request bug is not a reason to switch either.
    expect(classifySummaryError(httpError(400, "messages: field required"))).toBeNull();
    // A 404 from a mistyped base URL is a configuration error worth seeing.
    expect(classifySummaryError(httpError(404, "summarizer 404 Not Found: <html>"))).toBeNull();
    expect(classifySummaryError(new Error("socket hang up"))).toBeNull();
    expect(classifySummaryError(undefined)).toBeNull();
  });
});

describe("FallbackSummaryStreamer", () => {
  it("answers from the fallback when the primary has no credits, and says so once", async () => {
    const claude = new FakeStreamer("claude-api", fails(NO_CREDITS));
    const groq = new FakeStreamer("openai-api", answers("- **Kafka** for billing"));
    const notices: SummaryFallbackNotice[] = [];
    const streamer = new FallbackSummaryStreamer(claude, groq, (notice) => notices.push(notice));

    const shown: string[] = [];
    await expect(streamer.stream(INPUT, (delta) => shown.push(delta), new AbortController().signal)).resolves.toBe(
      "- **Kafka** for billing"
    );
    expect(shown).toEqual(["- **Kafka** for billing"]);
    expect(notices).toEqual([{ from: "claude-api", to: "openai-api", reason: "credit" }]);
    expect(streamer.id).toBe("openai-api");
  });

  it("stays on the fallback for the rest of the session", async () => {
    const claude = new FakeStreamer("claude-api", fails(NO_CREDITS));
    const groq = new FakeStreamer("openai-api", answers("ok"));
    const onFallback = vi.fn();
    const streamer = new FallbackSummaryStreamer(claude, groq, onFallback);
    const signal = new AbortController().signal;

    await streamer.stream(INPUT, () => undefined, signal);
    await streamer.stream(INPUT, () => undefined, signal);
    await streamer.stream(INPUT, () => undefined, signal);

    expect(claude.calls).toBe(1);
    expect(groq.calls).toBe(3);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("keeps the primary on a rate limit", async () => {
    const claude = new FakeStreamer("claude-api", fails(httpError(429, "rate limited")));
    const groq = new FakeStreamer("openai-api", answers("ok"));
    const streamer = new FallbackSummaryStreamer(claude, groq);

    await expect(streamer.stream(INPUT, () => undefined, new AbortController().signal)).rejects.toThrow("rate limited");
    expect(groq.calls).toBe(0);
    expect(streamer.id).toBe("claude-api");
  });

  it("does not re-run a request that already put text on screen", async () => {
    const claude = new FakeStreamer("claude-api", async (onDelta) => {
      onDelta("- first bullet");
      throw NO_CREDITS;
    });
    const groq = new FakeStreamer("openai-api", answers("- first bullet"));
    const streamer = new FallbackSummaryStreamer(claude, groq);

    await expect(streamer.stream(INPUT, () => undefined, new AbortController().signal)).rejects.toBe(NO_CREDITS);
    expect(groq.calls).toBe(0);
  });

  it("does not fall back after the caller aborted", async () => {
    const controller = new AbortController();
    const claude = new FakeStreamer("claude-api", async () => {
      controller.abort();
      throw NO_CREDITS;
    });
    const groq = new FakeStreamer("openai-api", answers("ok"));
    const streamer = new FallbackSummaryStreamer(claude, groq);

    await expect(streamer.stream(INPUT, () => undefined, controller.signal)).rejects.toBe(NO_CREDITS);
    expect(groq.calls).toBe(0);
  });
});

describe("createSummaryStreamer", () => {
  it("wraps Claude with the OpenAI-compatible fallback when auto picked it", () => {
    const streamer = createSummaryStreamer({ ANTHROPIC_API_KEY: "sk", MARSHAL_API_KEY: "gsk" });
    expect(streamer).toBeInstanceOf(FallbackSummaryStreamer);
    expect(streamer?.id).toBe("claude-api");
  });

  it("uses Claude alone when there is nothing to fall back to", () => {
    expect(createSummaryStreamer({ ANTHROPIC_API_KEY: "sk" })).toBeInstanceOf(AnthropicSummaryStreamer);
  });

  it("never wraps a provider the user chose explicitly", () => {
    const streamer = createSummaryStreamer({
      MARSHAL_CAPTIONS_PROVIDER: "claude-api",
      ANTHROPIC_API_KEY: "sk",
      MARSHAL_API_KEY: "gsk"
    });
    expect(streamer).toBeInstanceOf(AnthropicSummaryStreamer);
  });

  it("leaves the OpenAI-compatible provider unwrapped", () => {
    expect(createSummaryStreamer({ MARSHAL_API_KEY: "gsk" })).toBeInstanceOf(OpenAiCompatibleSummaryStreamer);
  });
});
