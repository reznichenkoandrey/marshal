import { describe, expect, it } from "vitest";

import { OpenAiSseParser } from "../desktop/captions/sse.ts";
import { buildAnthropicSystem, resolveSummaryProvider } from "../desktop/captions/summarizer.ts";
import {
  buildSummaryMessages,
  renderSummaryHtml,
  REFERENCE_CONTEXT_HEADER,
  SUMMARY_SYSTEM_PROMPT
} from "../desktop/captions/summary-prompt.ts";

describe("buildSummaryMessages", () => {
  it("uses the V3 scribe prompt verbatim and puts the transcript last", () => {
    const messages = buildSummaryMessages({
      transcript: "We shard by tenant id.",
      ocrContext: "Slide: Sharding strategy",
      outputLanguage: ""
    });
    expect(messages.system).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(SUMMARY_SYSTEM_PROMPT.startsWith("Act as an expert real-time business scribe.")).toBe(true);
    expect(messages.user.indexOf("Screen context")).toBeLessThan(messages.user.indexOf("Live transcript"));
    expect(messages.user).toContain("same language as the transcript");
  });

  it("omits the OCR block when there is no screen context and honours the output language", () => {
    const messages = buildSummaryMessages({ transcript: "hello", ocrContext: "  ", outputLanguage: "Ukrainian" });
    expect(messages.user).not.toContain("Screen context");
    expect(messages.user).toContain("in Ukrainian");
  });
});

describe("scribe-only scope (#211)", () => {
  // Every shape of input the service can produce. None of them may turn the
  // summarizer into something that answers questions or speaks as the user.
  const inputs = [
    { transcript: "How do you roll back a bad deploy?", ocrContext: "", outputLanguage: "" },
    { transcript: "We roll back with canaries.", ocrContext: "def solve(nums):", outputLanguage: "Ukrainian" },
    {
      transcript: "Can you walk me through your last project?",
      ocrContext: "",
      outputLanguage: "",
      referenceContext: "### agenda.md\nQ3 roadmap review, Kafka migration."
    }
  ];

  it("never instructs the model to answer or to speak as the user", () => {
    for (const input of inputs) {
      const messages = buildSummaryMessages(input);
      const everything = `${messages.system}\n${messages.user}`.toLowerCase();
      expect(everything, input.transcript).not.toMatch(/first person|answer (it|the question)|speak as|as the user|your experience/u);
      expect(everything, input.transcript).not.toContain("code snippet");
    }
  });

  it("uses the same system prompt whether or not the transcript ends with a question", () => {
    const [question, statement] = inputs;
    expect(buildSummaryMessages(question).system).toBe(buildSummaryMessages(statement).system);
  });
});

describe("reference context (#188, reframed in #211)", () => {
  it("adds nothing without reference files", () => {
    const messages = buildSummaryMessages({ transcript: "hi", ocrContext: "", outputLanguage: "", referenceContext: "  " });
    expect(messages.system).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(messages.referenceContext).toBe("");
    expect(buildAnthropicSystem(messages)).toEqual([{ type: "text", text: SUMMARY_SYSTEM_PROMPT }]);
  });

  it("keeps the scribe prompt and appends the files as terminology background", () => {
    const messages = buildSummaryMessages({
      transcript: "We are moving the billing consumers to Kafka.",
      ocrContext: "",
      outputLanguage: "",
      referenceContext: "### glossary.md\nKafka, billing-svc, ClickHouse."
    });
    expect(messages.systemInstructions).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(messages.system.startsWith(SUMMARY_SYSTEM_PROMPT)).toBe(true);
    expect(messages.system).toContain(REFERENCE_CONTEXT_HEADER);
    expect(REFERENCE_CONTEXT_HEADER).toContain("only what the speakers actually said");
    expect(messages.system).toContain("billing-svc");
    const blocks = buildAnthropicSystem(messages);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: SUMMARY_SYSTEM_PROMPT });
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].text).toContain("billing-svc");
  });
});

describe("renderSummaryHtml", () => {
  it("renders fenced code verbatim and escaped, also while the fence is still open (#188)", () => {
    expect(renderSummaryHtml("- Use a **bounded** queue\n```ts\nconst q = new Queue<Job>(100); // <cap>\n```\nDone.")).toBe(
      "<ul><li>Use a <strong>bounded</strong> queue</li></ul>" +
        "<pre><code>const q = new Queue&lt;Job&gt;(100); // &lt;cap&gt;</code></pre><p>Done.</p>"
    );
    expect(renderSummaryHtml("```py\nprint(1)")).toBe("<pre><code>print(1)</code></pre>");
  });

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
  it("prefers Anthropic, then the OpenAI-compatible key, then nothing", () => {
    // Claude first (#211): the OpenAI-compatible key is Groq's, and STT already competes for its limits.
    expect(resolveSummaryProvider({ MARSHAL_API_KEY: "gsk", ANTHROPIC_API_KEY: "sk" }).id).toBe("claude-api");
    expect(resolveSummaryProvider({ MARSHAL_API_KEY: "gsk" }).id).toBe("openai-api");
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
