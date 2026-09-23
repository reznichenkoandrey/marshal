// desktop/captions/transcript-buffer.ts
//
// Rolling context the summarizer is fed from: the last few transcribed
// utterances plus the most recent OCR snapshots. Bounded by characters, not
// by count, so the prompt stays a predictable size whether the speaker talks
// in fragments or paragraphs.
//
// Also owns the whisper hallucination filter. On near-silent clips whisper
// famously produces "Thank you." / "Subtitles by ..." / "[BLANK_AUDIO]";
// letting those through would put nonsense on the overlay and, worse, feed
// it to the summarizer as if somebody had said it.

export interface TranscriptLine {
  text: string;
  at: number;
}

export interface OcrSnapshot {
  text: string;
  at: number;
}

import { isFragment, isQuestion, joinFragment, stripFillers } from "./transcript-normalize.ts";

export interface TranscriptPushResult {
  /** A line was added (possibly the held fragment joined with this one). */
  accepted: boolean;
  /** The text as stored, after filler removal and fragment joining. */
  text: string;
  /** The stored line reads as a question — summarise now, not after the debounce. */
  question: boolean;
  /** Nothing stored: the input is being held as a half-sentence for the next segment. */
  held: boolean;
  /** The text was appended to the previous line instead of starting a new one. */
  continued?: boolean;
}

export interface TranscriptBufferOptions {
  /** Characters of transcript kept for the summarizer prompt. */
  maxTranscriptChars: number;
  /** Lines kept for the overlay's raw caption area. */
  maxDisplayLines: number;
  /** OCR snapshots kept. */
  maxOcrSnapshots: number;
  /** Characters kept per OCR snapshot. */
  maxOcrChars: number;
  /** OCR older than this is dropped from the prompt (ms). */
  ocrTtlMs: number;
  /** Utterances shorter than this many words are held as fragments. */
  fragmentMinWords: number;
  /**
   * A new utterance arriving within this many ms of a line that has no
   * terminal punctuation is appended to it instead of becoming its own line.
   *
   * This is how a sentence cut by a thinking pause is put back together
   * (#202). The join happens *after* the first half is already on screen,
   * deliberately: holding it back would mean waiting out FRAGMENT_HOLD_MS
   * before showing anything, which trades the cut for latency — the exact
   * trade this is meant to avoid. 0 disables.
   */
  continuationMs: number;
}

export const DEFAULT_TRANSCRIPT_BUFFER_OPTIONS: TranscriptBufferOptions = {
  maxTranscriptChars: 1_400,
  maxDisplayLines: 3,
  maxOcrSnapshots: 2,
  maxOcrChars: 1_500,
  ocrTtlMs: 3 * 60 * 1000,
  fragmentMinWords: 4,
  // Long enough to cover the silence window that closed the line plus its
  // transcription, short enough that a genuinely new sentence is not glued
  // onto the previous speaker's unfinished one.
  continuationMs: 1_200
};

const HALLUCINATION_PATTERNS: RegExp[] = [
  /^\[?blank[_ ]audio\]?$/iu,
  /^\(?(?:music|applause|laughter|silence|inaudible)\)?$/iu,
  /^(?:thank you|thanks|thank you\.|thanks for watching|bye|you)\.?$/iu,
  /subtitles? by/iu,
  /^♪+$/u
];

/**
 * True when the line reads as unfinished: whisper punctuates reliably, so a
 * line that ends without terminal punctuation was most likely cut off rather
 * than completed.
 */
export function looksUnfinished(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return !/[.!?…:;»"”')\]]$/u.test(trimmed);
}

/**
 * True when the text reads as the second half of somebody's sentence rather
 * than a new one. Whisper capitalises the start of a sentence, so a lowercase
 * opening is the signal — and it is the load-bearing half of the continuation
 * rule: "ends without a full stop" alone also matches short complete
 * utterances whisper left unpunctuated, and gluing those together produced
 * one endless line.
 */
export function looksLikeContinuation(text: string): boolean {
  const first = text.trim()[0];
  if (!first) return false;
  if (!/\p{L}/u.test(first)) return false;
  return first === first.toLocaleLowerCase() && first !== first.toLocaleUpperCase();
}

/** True when whisper's output is the kind of filler it invents for silence. */
export function isLikelyHallucination(text: string): boolean {
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) return true;
  // Nothing that reads as a word at all — punctuation, symbols, music notes.
  if (!/\p{L}/u.test(normalized)) return true;
  const stripped = normalized.replace(/[.!?…]+$/u, "");
  return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(stripped) || pattern.test(normalized));
}

export class TranscriptBuffer {
  private readonly options: TranscriptBufferOptions;
  private lines: TranscriptLine[] = [];
  private ocr: OcrSnapshot[] = [];
  /** A half-sentence waiting for its other half. */
  private fragment: string | null = null;

  constructor(options: Partial<TranscriptBufferOptions> = {}) {
    this.options = { ...DEFAULT_TRANSCRIPT_BUFFER_OPTIONS, ...options };
  }

  /**
   * Adds a transcribed utterance. Hallucinations are dropped, fillers are
   * stripped, and a half-sentence is held back until the next utterance
   * completes it (or `flushFragment` gives up on it).
   */
  pushTranscript(text: string, at = Date.now()): TranscriptPushResult {
    const rejected: TranscriptPushResult = { accepted: false, text: "", question: false, held: false };
    const cleaned = text.trim().replace(/\s+/gu, " ");
    if (isLikelyHallucination(cleaned)) return rejected;
    const stripped = stripFillers(cleaned);
    if (stripped.length === 0) return rejected;

    const joined = this.fragment ? joinFragment(this.fragment, stripped) : stripped;
    this.fragment = null;
    if (isFragment(joined, this.options.fragmentMinWords)) {
      this.fragment = joined;
      return { accepted: false, text: joined, question: false, held: true };
    }

    // A sentence the segmenter cut at a thinking pause: append to the line it
    // belongs to rather than starting a new one (#202).
    const previous = this.lines[this.lines.length - 1];
    if (
      previous &&
      this.options.continuationMs > 0 &&
      at - previous.at <= this.options.continuationMs &&
      looksUnfinished(previous.text) &&
      looksLikeContinuation(joined)
    ) {
      const merged = joinFragment(previous.text, joined);
      previous.text = merged;
      previous.at = at;
      this.trimTranscript();
      return { accepted: true, text: merged, question: isQuestion(merged), held: false, continued: true };
    }

    this.lines.push({ text: joined, at });
    this.trimTranscript();
    return { accepted: true, text: joined, question: isQuestion(joined), held: false };
  }

  /** The half-sentence currently held, if any. */
  heldFragment(): string | null {
    return this.fragment;
  }

  /**
   * Stores the held fragment on its own. The service calls this when no
   * continuation arrived in time — a short answer ("Redis.") is still worth
   * a caption, just not worth waiting for.
   */
  flushFragment(at = Date.now()): TranscriptPushResult {
    const fragment = this.fragment;
    this.fragment = null;
    if (!fragment) return { accepted: false, text: "", question: false, held: false };
    this.lines.push({ text: fragment, at });
    this.trimTranscript();
    return { accepted: true, text: fragment, question: isQuestion(fragment), held: false };
  }

  pushOcr(text: string, at = Date.now()): boolean {
    const cleaned = text.trim();
    if (cleaned.length === 0) return false;
    this.ocr.push({ text: cleaned.slice(0, this.options.maxOcrChars), at });
    if (this.ocr.length > this.options.maxOcrSnapshots) {
      this.ocr = this.ocr.slice(-this.options.maxOcrSnapshots);
    }
    return true;
  }

  /** Recent utterances for the overlay, oldest first. */
  displayLines(): string[] {
    return this.lines.slice(-this.options.maxDisplayLines).map((line) => line.text);
  }

  /** Everything the summarizer should see, trimmed to the character budget. */
  transcriptText(): string {
    return this.lines.map((line) => line.text).join("\n");
  }

  ocrText(now = Date.now()): string {
    return this.ocr
      .filter((snapshot) => now - snapshot.at <= this.options.ocrTtlMs)
      .map((snapshot) => snapshot.text)
      .join("\n---\n");
  }

  hasTranscript(): boolean {
    return this.lines.length > 0;
  }

  clear(): void {
    this.lines = [];
    this.ocr = [];
    this.fragment = null;
  }

  private trimTranscript(): void {
    let total = this.lines.reduce((sum, line) => sum + line.text.length + 1, 0);
    while (this.lines.length > 1 && total > this.options.maxTranscriptChars) {
      const dropped = this.lines.shift();
      total -= (dropped?.text.length ?? 0) + 1;
    }
  }
}
