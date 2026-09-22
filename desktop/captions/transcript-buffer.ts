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
}

export const DEFAULT_TRANSCRIPT_BUFFER_OPTIONS: TranscriptBufferOptions = {
  maxTranscriptChars: 1_400,
  maxDisplayLines: 3,
  maxOcrSnapshots: 2,
  maxOcrChars: 1_500,
  ocrTtlMs: 3 * 60 * 1000
};

const HALLUCINATION_PATTERNS: RegExp[] = [
  /^\[?blank[_ ]audio\]?$/iu,
  /^\(?(?:music|applause|laughter|silence|inaudible)\)?$/iu,
  /^(?:thank you|thanks|thank you\.|thanks for watching|bye|you)\.?$/iu,
  /subtitles? by/iu,
  /^♪+$/u
];

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

  constructor(options: Partial<TranscriptBufferOptions> = {}) {
    this.options = { ...DEFAULT_TRANSCRIPT_BUFFER_OPTIONS, ...options };
  }

  /** Returns false when the line was rejected (empty or a hallucination). */
  pushTranscript(text: string, at = Date.now()): boolean {
    const cleaned = text.trim().replace(/\s+/gu, " ");
    if (isLikelyHallucination(cleaned)) return false;
    this.lines.push({ text: cleaned, at });
    this.trimTranscript();
    return true;
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
  }

  private trimTranscript(): void {
    let total = this.lines.reduce((sum, line) => sum + line.text.length + 1, 0);
    while (this.lines.length > 1 && total > this.options.maxTranscriptChars) {
      const dropped = this.lines.shift();
      total -= (dropped?.text.length ?? 0) + 1;
    }
  }
}
