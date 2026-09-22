import { describe, expect, it } from "vitest";

import { isLikelyHallucination, TranscriptBuffer } from "../desktop/captions/transcript-buffer.ts";

describe("isLikelyHallucination", () => {
  it("rejects whisper's silence fillers", () => {
    for (const text of ["Thank you.", "thanks for watching", "[BLANK_AUDIO]", "(music)", "♪♪", "  ", "...", "you"]) {
      expect(isLikelyHallucination(text), text).toBe(true);
    }
  });

  it("keeps real speech, including short technical answers", () => {
    for (const text of ["We use Kafka for the event bus.", "Так, деплой у п'ятницю.", "O(n log n)", "Redis"]) {
      expect(isLikelyHallucination(text), text).toBe(false);
    }
  });
});

describe("TranscriptBuffer", () => {
  it("keeps the last lines for display and everything within the char budget for the prompt", () => {
    const buffer = new TranscriptBuffer({ maxTranscriptChars: 60, maxDisplayLines: 2 });
    buffer.pushTranscript("first sentence about caching");
    buffer.pushTranscript("second sentence about queues");
    buffer.pushTranscript("third sentence about retries");
    expect(buffer.displayLines()).toEqual(["second sentence about queues", "third sentence about retries"]);
    // 3 × 29 chars > 60, so the oldest line is gone from the prompt too.
    expect(buffer.transcriptText()).not.toContain("first");
    expect(buffer.transcriptText()).toContain("third");
  });

  it("never drops the only line even if it exceeds the budget", () => {
    const buffer = new TranscriptBuffer({ maxTranscriptChars: 10 });
    expect(buffer.pushTranscript("a sentence that is definitely longer than ten characters")).toBe(true);
    expect(buffer.hasTranscript()).toBe(true);
  });

  it("drops hallucinations and reports it", () => {
    const buffer = new TranscriptBuffer();
    expect(buffer.pushTranscript("Thank you.")).toBe(false);
    expect(buffer.hasTranscript()).toBe(false);
  });

  it("expires OCR context and caps the number of snapshots", () => {
    const buffer = new TranscriptBuffer({ maxOcrSnapshots: 2, ocrTtlMs: 1_000 });
    buffer.pushOcr("slide one", 0);
    buffer.pushOcr("slide two", 500);
    buffer.pushOcr("slide three", 900);
    expect(buffer.ocrText(1_000)).toBe("slide two\n---\nslide three");
    expect(buffer.ocrText(1_600)).toBe("slide three");
    expect(buffer.ocrText(5_000)).toBe("");
  });

  it("ignores empty OCR results", () => {
    const buffer = new TranscriptBuffer();
    expect(buffer.pushOcr("   \n ")).toBe(false);
  });
});
