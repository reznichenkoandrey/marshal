import { describe, expect, it } from "vitest";

import { OpenAiSseParser } from "../desktop/captions/sse.ts";
import { resolveSummaryProvider } from "../desktop/captions/summarizer.ts";
import {
  buildSummaryMessages,
  renderSummaryHtml,
  SUMMARY_SYSTEM_PROMPT
} from "../desktop/captions/summary-prompt.ts";

describe("buildSummaryMessages", () => {
  it("uses the spec's system prompt verbatim and puts the transcript last", () => {
    const messages = buildSummaryMessages({
      transcript: "We shard by tenant id.",
      ocrContext: "Slide: Sharding strategy",
      outputLanguage: ""
    });
    expect(messages.system).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(messages.user.indexOf("Screen context")).toBeLessThan(messages.user.indexOf("Live transcript"));
    expect(messages.user).toContain("same language as the transcript");
  });

  it("omits the OCR block when there is no screen context and honours the output language", () => {
    const messages = buildSummaryMessages({ transcript: "hello", ocrContext: "  ", outputLanguage: "Ukrainian" });
    expect(messages.user).not.toContain("Screen context");
    expect(messages.user).toContain("in Ukrainian");
  });
});

describe("renderSummaryHtml", () => {
  it("turns bullets into a list and bold into <strong>", () => {
    const html = renderSummaryHtml("- Uses **Kafka** for events\n* Latency target `p99 < 200ms`");
    expect(html).toBe(
      "<ul><li>Uses <strong>Kafka</strong> for events</li>" +
        "<li>Latency target <code>p99 &lt; 200ms</code></li></ul>"
    );
  });

  it("escapes HTML that the model might emit", () => {
    const html = renderSummaryHtml('<img src=x onerror="alert(1)"> **safe**');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>safe</strong>");
  });

  it("leaves an unfinished bold marker literal while streaming", () => {
    expect(renderSummaryHtml("- Uses **Kaf")).toBe("<ul><li>Uses **Kaf</li></ul>");
  });

  it("renders plain lines as paragraphs and blank lines as separators", () => {
    expect(renderSummaryHtml("Intro\n\n1. first\n2) second")).toBe(
      "<p>Intro</p><ul><li>first</li><li>second</li></ul>"
    );
  });
});

describe("OpenAiSseParser", () => {
  it("yields deltas across chunk boundaries and stops at [DONE]", () => {
    const parser = new OpenAiSseParser();
    const part1 = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"con';
    const part2 = 'tent":"lo"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"ignored"}}]}\n';
    expect(parser.push(part1)).toEqual(["Hel"]);
    expect(parser.push(part2)).toEqual(["lo"]);
    expect(parser.done).toBe(true);
    expect(parser.push('data: {"choices":[{"delta":{"content":"late"}}]}\n')).toEqual([]);
  });

  it("skips role-only and malformed events", () => {
    const parser = new OpenAiSseParser();
    const deltas = parser.push('data: {"choices":[{"delta":{"role":"assistant"}}]}\ndata: {not json\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n');
    expect(deltas).toEqual(["ok"]);
  });
});

describe("resolveSummaryProvider", () => {
  it("prefers the OpenAI-compatible key, then Anthropic, then nothing", () => {
    expect(resolveSummaryProvider({ MARSHAL_API_KEY: "gsk", ANTHROPIC_API_KEY: "sk" }).id).toBe("openai-api");
    expect(resolveSummaryProvider({ ANTHROPIC_API_KEY: "sk" }).id).toBe("claude-api");
    expect(resolveSummaryProvider({}).id).toBe("off");
  });

  it("treats a local base (Ollama) as usable without a key", () => {
    expect(resolveSummaryProvider({ MARSHAL_CAPTIONS_API_BASE: "http://127.0.0.1:11434/v1" }).id).toBe("openai-api");
  });

  it("honours an explicit choice and falls back to off when its credentials are missing", () => {
    expect(resolveSummaryProvider({ MARSHAL_CAPTIONS_PROVIDER: "off", MARSHAL_API_KEY: "gsk" }).id).toBe("off");
    expect(resolveSummaryProvider({ MARSHAL_CAPTIONS_PROVIDER: "claude-api", MARSHAL_API_KEY: "gsk" }).id).toBe("off");
    expect(resolveSummaryProvider({ MARSHAL_CAPTIONS_PROVIDER: "claude-api", ANTHROPIC_API_KEY: "sk" }).id).toBe("claude-api");
  });
});
