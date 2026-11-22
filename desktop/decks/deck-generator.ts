// desktop/decks/deck-generator.ts
//
// From the owner's words to a deck (#277, stage 2): what was asked, the prompt,
// and the loop that turns the model's stream into slides as they complete.
// Pure: the model arrives as a function, so nothing here needs Electron or a
// network in tests.

import type { SummaryMessages } from "../captions/summary-prompt.js";
import { detectSpeechLang } from "../speech/speech-policy.js";
import {
  applyDeckOp,
  createDeck,
  parseDeckOp,
  type Deck,
  type DeckLanguage
} from "./deck-model.js";
import { OpScanner, partialStringField } from "./op-scanner.js";
import { sanitizeSlideHtml } from "./sanitize.js";

export const DEFAULT_SLIDE_COUNT = 5;
export const MAX_GENERATED_SLIDES = 12;
/** The open slide is redrawn at most this often while it grows. */
export const PARTIAL_INTERVAL_MS = 250;

export interface DeckRequest {
  topic: string;
  slideCount: number;
  language: DeckLanguage;
}

export type DeckStream = (
  messages: SummaryMessages,
  maxTokens: number,
  onDelta: (delta: string) => void,
  signal: AbortSignal
) => Promise<string>;

const NUMBER_WORDS: Record<string, number> = {
  один: 1, одного: 1, два: 2, двох: 2, три: 3, трьох: 3, чотири: 4, чотирьох: 4,
  "п'ять": 5, "п'яти": 5, шість: 6, шести: 6, сім: 7, семи: 7, вісім: 8, восьми: 8,
  "дев'ять": 9, "дев'яти": 9, десять: 10, десяти: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

/** How many words before "slides" may hold the count: "5 коротких слайдів". */
const COUNT_LOOKBEHIND = 2;

/**
 * What the owner asked for. The topic is their words as said: the model reads
 * "5 slides about …" fine, and cutting the phrase by rule would lose meaning.
 * The language is the language of the request, not of the interface.
 */
export function parseDeckRequest(words: string): DeckRequest | null {
  const topic = words.replace(/\s+/g, " ").trim();
  if (!topic) return null;
  let slideCount = DEFAULT_SLIDE_COUNT;
  const tokens = topic.toLowerCase().replace(/[’ʼ`]/g, "'").split(/[^\p{L}\d']+/u);
  const at = tokens.findIndex((token) => /^(?:слайд|slide)/u.test(token));
  for (const token of tokens.slice(Math.max(at - COUNT_LOOKBEHIND, 0), Math.max(at, 0)).reverse()) {
    const count = /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token];
    if (count) {
      slideCount = Math.min(Math.max(count, 1), MAX_GENERATED_SLIDES);
      break;
    }
  }
  return { topic, slideCount, language: detectSpeechLang(topic, "uk") };
}

const LANGUAGE_NAMES: Record<DeckLanguage, string> = { uk: "Ukrainian", en: "English" };

export function buildDeckMessages(request: DeckRequest): SummaryMessages {
  const language = LANGUAGE_NAMES[request.language];
  const system = [
    "You write slide decks. Output only JSON objects, one per line. No markdown fence, no prose before or after.",
    'Line 1: {"op":"deck","title":"<deck title>","outline":["<title of slide 1>","<title of slide 2>", ...]}',
    'Then one line per slide, in order: {"op":"slide","index":<1-based number>,"layout":"<title|bullets|content|quote>","html":"<slide html>","notes":"<what the presenter says, 1-3 sentences>"}',
    `Write exactly ${request.slideCount} slides; the outline has the same ${request.slideCount} titles.`,
    "Slide html may use only these tags: h1 h2 h3 p ul ol li strong em code blockquote table tr th td. No attributes, no links, no images, no scripts, no styles.",
    'Slide 1 has layout "title": an <h1> and at most one <p>. Every other slide starts with an <h2> title, followed by at most 5 short bullets or 2 short paragraphs. A slide is read from across a room: keep it brief.',
    `Write every title, every slide and every note in ${language}, whatever language the request is phrased in. Keep technical terms, product names and identifiers exactly as written.`,
    "Use only facts given in the request. Do not invent numbers, dates, names or quotes; where specifics are unknown, write statements that are true in general."
  ].join("\n");
  return {
    system,
    systemInstructions: system,
    referenceContext: "",
    user: `Request: ${request.topic}\nSlides: ${request.slideCount}\nLanguage: ${language}`
  };
}

/** Room for the outline plus every slide with its notes. */
export function deckMaxTokens(slideCount: number): number {
  return Math.min(600 + slideCount * 700, 8192);
}

export type DeckBuildEvent =
  | { type: "outline"; titles: string[] }
  | { type: "slide"; deck: Deck }
  | { type: "partial"; index: number; html: string };

export interface DeckBuildResult {
  deck: Deck;
  /** Set when the stream failed or was aborted; the slides built so far are kept. */
  error: string | null;
}

/**
 * Runs one generation. Each slide is applied the moment its operation closes;
 * the slide still being written is reported as sanitised html, throttled.
 * Refused operations go to `log` and never stop the build.
 */
export async function generateDeck(input: {
  id: string;
  request: DeckRequest;
  stream: DeckStream;
  signal: AbortSignal;
  onEvent: (event: DeckBuildEvent) => void;
  log?: (line: string) => void;
  now?: () => number;
}): Promise<DeckBuildResult> {
  const { request, onEvent } = input;
  const now = input.now ?? Date.now;
  const scanner = new OpScanner();
  let deck = createDeck({ id: input.id, title: request.topic, language: request.language, now: now() });
  let lastPartialAt = 0;

  const onDelta = (delta: string): void => {
    for (const scanned of scanner.feed(delta)) {
      const op = scanned.ok ? parseDeckOp(scanned.value) : scanned;
      if (!op.ok) {
        input.log?.(op.reason);
        continue;
      }
      if (op.value.op === "slide" && op.value.index > request.slideCount) {
        input.log?.(`slide ${op.value.index} is past the ${request.slideCount} requested`);
        continue;
      }
      // The request decides the language; the model's own claim is ignored.
      const applied = applyDeckOp(deck, op.value.op === "deck" ? { ...op.value, language: undefined } : op.value, now());
      if (!applied.ok) {
        input.log?.(applied.reason);
        continue;
      }
      deck = applied.value;
      if (op.value.op === "deck") {
        if (op.value.outline?.length) onEvent({ type: "outline", titles: op.value.outline });
      }
      onEvent({ type: "slide", deck });
    }
    const open = partialStringField(scanner.pending, "html");
    if (open && deck.slides.length < request.slideCount && now() - lastPartialAt >= PARTIAL_INTERVAL_MS) {
      lastPartialAt = now();
      onEvent({ type: "partial", index: deck.slides.length + 1, html: sanitizeSlideHtml(open) });
    }
  };

  try {
    await input.stream(buildDeckMessages(request), deckMaxTokens(request.slideCount), onDelta, input.signal);
  } catch (error) {
    return { deck, error: error instanceof Error ? error.message : String(error) };
  }
  return { deck, error: null };
}
