// One-line summary of a Claude Code session's last answer for the "finished"
// notification. Same providers and credentials as the captions summarizer
// (resolveSummaryProvider), but one short non-streamed request: a
// notification shows the whole line at once, so streaming buys nothing.

import Anthropic from "@anthropic-ai/sdk";

import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_OPENAI_BASE,
  DEFAULT_OPENAI_MODEL,
  resolveSummaryProvider,
  type SummarizerEnv
} from "../captions/summarizer.ts";
import { looksUkrainian } from "./hook-events.ts";

export type SummaryLanguage = "auto" | "uk" | "en";

const SYSTEM_PROMPT =
  "You write one-line desktop notifications about what a coding assistant just reported to its user. " +
  "Reply with a single line of at most 100 characters stating the outcome. No preamble, no quotes, no markdown.";
// The conclusion of an answer is at its end; the head is usually the plan.
const MAX_INPUT_CHARS = 6000;
const TIMEOUT_MS = 8000;

export function summaryLanguageName(text: string, setting: SummaryLanguage): string {
  if (setting === "uk") return "Ukrainian";
  if (setting === "en") return "English";
  return looksUkrainian(text) ? "Ukrainian" : "English";
}

export function buildSummaryRequest(text: string, setting: SummaryLanguage): { system: string; user: string } {
  return {
    system: SYSTEM_PROMPT,
    user: `Write it in ${summaryLanguageName(text, setting)}.\n\nThe assistant's last answer:\n${text.slice(-MAX_INPUT_CHARS)}`
  };
}

// Reasoning models on OpenAI-compatible endpoints may prepend their thinking.
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gu, "").trim();
}

function firstLine(text: string): string | null {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line === "" ? null : line;
}

export type OneShotRequest = { system: string; user: string; maxTokens: number; label: string };

/**
 * One short, non-streamed completion through the captions summarizer's
 * provider and credentials. Null when no provider is configured or the
 * request fails — every caller has a fallback. Shared by the "finished"
 * summary and context routing (#286), so neither adds an SDK of its own.
 */
export async function completeOnce(
  { system, user, maxTokens, label }: OneShotRequest,
  env: SummarizerEnv = process.env
): Promise<string | null> {
  const provider = resolveSummaryProvider(env).id;
  if (provider === "off") return null;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    if (provider === "claude-api") {
      const message = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).messages.create(
        {
          model: env.MARSHAL_CAPTIONS_CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }]
        },
        { signal }
      );
      return stripThinking(message.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
    }
    const apiKey = env.MARSHAL_CAPTIONS_API_KEY ?? env.MARSHAL_API_KEY ?? "";
    const base = (env.MARSHAL_CAPTIONS_API_BASE ?? env.MARSHAL_API_BASE ?? DEFAULT_OPENAI_BASE).replace(/\/+$/u, "");
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: env.MARSHAL_CAPTIONS_MODEL ?? env.MARSHAL_TRANSLATOR_MODEL ?? DEFAULT_OPENAI_MODEL,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    if (!response.ok) throw new Error(`${label} ${response.status}`);
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return stripThinking(data.choices?.[0]?.message?.content ?? "");
  } catch (err) {
    console.warn(`[claude-code] ${label} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Null when no provider is configured or the request fails — the caller has a fallback. */
export async function summarizeAnswer(
  text: string,
  setting: SummaryLanguage,
  env: SummarizerEnv = process.env
): Promise<string | null> {
  if (text.trim() === "") return null;
  const reply = await completeOnce({ ...buildSummaryRequest(text, setting), maxTokens: 80, label: "answer summary" }, env);
  return reply === null ? null : firstLine(reply);
}
