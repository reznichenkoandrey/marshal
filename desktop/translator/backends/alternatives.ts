// desktop/translator/backends/alternatives.ts
//
// Prompt and JSON contract for word-level alternative translations (#146).
//
// The design decision worth knowing: every alternative carries the whole
// sentence rewritten around it, not just the replacement word. DeepL rewrites
// the tail of the sentence after a pick, which costs a second round trip per
// choice; asking for both at once costs a handful of extra tokens on a request
// that is already sentence-sized, and makes applying a choice instant. The
// renderer caches per (sentence, word), so re-opening a popover is free.

import { languageName } from "../languages.ts";
import type { AlternativeOption, AlternativesRequest } from "./types.ts";
import { extractBracedJson, formalityClause, glossaryClause, stripCodeFence } from "./shared.ts";

/**
 * How many alternatives to ask for. Five fills a popover without scrolling and
 * keeps a local CLI backend — where a click already costs seconds — from
 * generating a paragraph of variants nobody reads.
 */
export const MAX_ALTERNATIVES = 5;

/** Hard caps on what the renderer may send, mirrored by the IPC normalizer. */
export const MAX_SENTENCE_CHARS = 1000;
export const MAX_WORD_CHARS = 80;

export function buildAlternativesPrompt(request: AlternativesRequest): string {
  const targetName = languageName(request.targetLang);
  const sourceClause = request.sourceText
    ? `\nThe sentence was translated from this original text:\n${request.sourceText}\n`
    : "";

  return (
    `You are a translation assistant. A ${targetName} translation is on screen and the user ` +
    `clicked one word in it, asking for other ways to render it.` +
    `${formalityClause(request.options)}` +
    `${glossaryClause(request.options, request.targetLang)}\n` +
    `${sourceClause}` +
    `\nSentence:\n${request.sentence}\n` +
    `\nClicked word: "${request.word}" (character offset ${request.wordOffset} in the sentence).\n` +
    `\nReturn at most ${MAX_ALTERNATIVES} alternative renderings of that word in ${targetName}, ` +
    `ordered from most to least natural in this context. Rules:\n` +
    `- Each alternative must differ from "${request.word}" and from the other alternatives.\n` +
    `- Stay faithful to the original meaning; do not offer a word that changes it.\n` +
    `- For every alternative, also return the ENTIRE sentence rewritten with that word in ` +
    `place of "${request.word}", adjusting agreement, case and word order so the sentence ` +
    `stays grammatical. Change nothing else in the sentence.\n` +
    `- Keep the sentence's original punctuation and capitalization.\n` +
    `- If the word has no reasonable alternative, return an empty list.\n` +
    `\nRespond with ONLY a JSON object of the form ` +
    `{"alternatives":[{"word":"<alternative>","sentence":"<rewritten sentence>"}]}. ` +
    `No markdown, no code fences, no commentary.`
  );
}

/**
 * Parses an alternatives response. Accepts raw JSON, code-fenced JSON, or JSON
 * embedded in commentary — the same three shapes parseTranslateJson tolerates,
 * because the same local CLI backends produce them.
 *
 * Drops entries that repeat the clicked word or each other, and anything
 * missing a rewritten sentence: an alternative you cannot apply is worse than
 * one fewer option in the list. Returns [] when nothing parses, which the UI
 * shows as "no alternatives" rather than as an error.
 */
export function parseAlternativesJson(raw: string, clickedWord: string): AlternativeOption[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];

  const candidates = [trimmed, stripCodeFence(trimmed), extractBracedJson(trimmed)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as { alternatives?: unknown };
      const list = collect(parsed.alternatives, clickedWord);
      if (list.length > 0) return list;
      // A well-formed empty list is a real answer ("no alternatives"), so stop
      // here instead of letting a later candidate parse something else.
      if (Array.isArray(parsed.alternatives)) return [];
    } catch {
      // try next candidate
    }
  }
  return [];
}

function collect(value: unknown, clickedWord: string): AlternativeOption[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>([clickedWord.trim().toLocaleLowerCase()]);
  const options: AlternativeOption[] = [];

  for (const entry of value) {
    if (options.length >= MAX_ALTERNATIVES) break;
    if (!entry || typeof entry !== "object") continue;

    const record = entry as { word?: unknown; sentence?: unknown };
    const word = typeof record.word === "string" ? record.word.trim() : "";
    const sentence = typeof record.sentence === "string" ? record.sentence.trim() : "";
    if (!word || !sentence) continue;

    const key = word.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ word, sentence });
  }

  return options;
}

/**
 * Trims an incoming request to the documented limits. Applied in the main
 * process, so a stale renderer after an update cannot push a whole document
 * into a prompt that is supposed to be sentence-sized.
 */
export function clampAlternativesRequest<T extends AlternativesRequest>(request: T): T {
  const sentence = request.sentence.slice(0, MAX_SENTENCE_CHARS);
  const word = request.word.slice(0, MAX_WORD_CHARS);
  return {
    ...request,
    sentence,
    word,
    wordOffset: Math.max(0, Math.min(Math.trunc(request.wordOffset) || 0, sentence.length))
  };
}
