// Prompts of voice boards (#276, docs/VOICE_BOARDS.md §3.1 and §4). Pure:
// the model call itself is `completeOnce`, injected by the window.

import { summaryLanguageName, type OneShotRequest, type SummaryLanguage } from "../claude-code/answer-summary.ts";

export type BoardLanguage = SummaryLanguage;

// A diagram takes longer than a one-line summary, which is what the default timeout is sized for.
const BOARD_TIMEOUT_MS = 45_000;
const MAX_TOKENS = 1500;
const MAX_REQUEST_CHARS = 4000;
const MAX_SOURCE_CHARS = 8000;
const MAX_ERROR_CHARS = 600;

export function parseBoardLanguage(value: unknown): BoardLanguage {
  return value === "uk" || value === "en" ? value : "auto";
}

function rules(language: string): string {
  return [
    "You draw one Mermaid diagram for a board window.",
    "Reply with exactly one fenced ```mermaid block and nothing else: no prose, no second block.",
    "Pick the diagram type that fits the request: flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, gantt, mindmap or timeline.",
    "Mermaid keywords and node ids are always English ASCII (ids: letters, digits, underscore).",
    `Every visible label and text is in ${language}.`,
    "Technical terms stay exactly as written, never translated: rate limit, deploy, webhook, cache, identifiers, file names.",
    'Quote every label: id["label"] in flowcharts, "label" wherever the diagram type accepts a quoted string.',
    'Inside a label write #quot; instead of a double quote. Characters ( ) [ ] : ; # are allowed only inside a quoted label.',
    // A sequence message cannot be quoted, and ";" ends the statement there (found with the real parser).
    "In sequenceDiagram message text, which cannot be quoted, write #59; instead of a semicolon and #35; instead of #.",
    "No HTML tags, no click handlers, no links, no init directives."
  ].join("\n");
}

/** Request → one Mermaid diagram. `setting` forces the label language; `auto` follows the request. */
export function buildBoardRequest(request: string, setting: BoardLanguage): OneShotRequest {
  const text = request.trim().slice(0, MAX_REQUEST_CHARS);
  return {
    system: rules(summaryLanguageName(text, setting)),
    user: text,
    maxTokens: MAX_TOKENS,
    label: "board diagram",
    timeoutMs: BOARD_TIMEOUT_MS
  };
}

/** The one repair retry: the broken source and Mermaid's error go back to the model. */
export function buildRepairRequest(source: string, error: string, setting: BoardLanguage): OneShotRequest {
  const broken = source.slice(0, MAX_SOURCE_CHARS);
  return {
    system: `${rules(summaryLanguageName(broken, setting))}\nYou are fixing a diagram that failed to parse. Keep its meaning, nodes and labels; change only what the error requires.`,
    user: `Mermaid error:\n${error.slice(0, MAX_ERROR_CHARS)}\n\nBroken source:\n\`\`\`mermaid\n${broken}\n\`\`\``,
    maxTokens: MAX_TOKENS,
    label: "board repair",
    timeoutMs: BOARD_TIMEOUT_MS
  };
}

export type BoardReply = { ok: true; text: string } | { ok: false; error: string };
export type BoardComplete = (request: OneShotRequest) => Promise<string | null>;

/** One model call; null (no provider, timeout, HTTP error) becomes a message the window can show. */
export async function askBoardModel(request: OneShotRequest, complete: BoardComplete, failure: string): Promise<BoardReply> {
  const text = (await complete(request))?.trim() ?? "";
  return text === "" ? { ok: false, error: failure } : { ok: true, text };
}
