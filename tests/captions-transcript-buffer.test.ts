import { describe, expect, it } from "vitest";

import { isLikelyHallucination, TranscriptBuffer } from "../desktop/captions/transcript-buffer.ts";
import { isFragment, isQuestion, joinFragment, stripFillers } from "../desktop/captions/transcript-normalize.ts";

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
    expect(buffer.pushTranscript("a sentence that is definitely longer than ten characters").accepted).toBe(true);
    expect(buffer.hasTranscript()).toBe(true);
  });

  it("drops hallucinations and reports it", () => {
    const buffer = new TranscriptBuffer();
    expect(buffer.pushTranscript("Thank you.").accepted).toBe(false);
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

describe("stripFillers (#187)", () => {
  it("removes English and Ukrainian fillers and the punctuation they strand", () => {
    expect(stripFillers("Um, so we, uh, use Kafka, you know, for events.")).toBe("We, use Kafka, for events.");
    expect(stripFillers("Ну, типу, ми деплоїмо в п'ятницю, е-е, після рев'ю.")).toBe("Ми деплоїмо в п'ятницю, після рев'ю.");
  });

  it("only treats 'like' as a filler when it is an aside", () => {
    expect(stripFillers("I like Kafka for this.")).toBe("I like Kafka for this.");
    expect(stripFillers("We use, like, three partitions.")).toBe("We use, three partitions.");
    expect(stripFillers("Like, three partitions per tenant.")).toBe("Three partitions per tenant.");
  });

  it("does not touch words that merely contain a filler", () => {
    expect(stripFillers("The album summary is humble.")).toBe("The album summary is humble.");
    expect(stripFillers("Нуль помилок, отже все ок.")).toBe("Нуль помилок, отже все ок.");
  });
});

describe("isFragment / joinFragment (#187)", () => {
  it("holds short and cut-off pieces but keeps short complete answers", () => {
    expect(isFragment("and then the —")).toBe(true);
    expect(isFragment("so we")).toBe(true);
    expect(isFragment("Redis.")).toBe(false);
    expect(isFragment("Yes?")).toBe(false);
    expect(isFragment("we shard by tenant id")).toBe(false);
  });

  it("joins a fragment with its continuation without the dangling dash", () => {
    expect(joinFragment("and then the —", "Consumer falls behind.")).toBe("and then the consumer falls behind.");
    expect(joinFragment("", "Plain.")).toBe("Plain.");
  });
});

describe("isQuestion (#187)", () => {
  it("trusts a question mark, then an interrogative opener without terminal punctuation", () => {
    expect(isQuestion("How do you handle backpressure?")).toBe(true);
    expect(isQuestion("Як ви робите rollback?")).toBe(true);
    expect(isQuestion("how do you handle backpressure")).toBe(true);
    expect(isQuestion("Чому ви обрали Kafka")).toBe(true);
    expect(isQuestion("We handle backpressure with bounded queues.")).toBe(false);
    expect(isQuestion("What we do is bounded queues.")).toBe(false);
    expect(isQuestion("How")).toBe(false);
  });
});

describe("TranscriptBuffer turn handling (#187)", () => {
  it("strips fillers before storing and flags questions", () => {
    const buffer = new TranscriptBuffer();
    const result = buffer.pushTranscript("Um, how do you, uh, roll back a bad deploy?");
    expect(result).toEqual({ accepted: true, text: "How do you, roll back a bad deploy?", question: true, held: false });
    expect(buffer.displayLines()).toEqual(["How do you, roll back a bad deploy?"]);
  });

  it("holds a half-sentence and glues it to the next utterance", () => {
    const buffer = new TranscriptBuffer();
    const first = buffer.pushTranscript("and then the —");
    expect(first).toEqual({ accepted: false, text: "and then the —", question: false, held: true });
    expect(buffer.heldFragment()).toBe("and then the —");
    expect(buffer.displayLines()).toEqual([]);
    const second = buffer.pushTranscript("Consumer falls behind and we pause the partition.");
    expect(second.accepted).toBe(true);
    expect(second.text).toBe("and then the consumer falls behind and we pause the partition.");
    expect(buffer.heldFragment()).toBeNull();
  });

  it("flushes a held fragment on its own when asked, and reports a question in it", () => {
    const buffer = new TranscriptBuffer();
    expect(buffer.pushTranscript("Why though").held).toBe(true);
    const flushed = buffer.flushFragment();
    expect(flushed).toEqual({ accepted: true, text: "Why though", question: true, held: false });
    expect(buffer.flushFragment().accepted).toBe(false);
  });

  it("drops an utterance that is nothing but fillers", () => {
    const buffer = new TranscriptBuffer();
    expect(buffer.pushTranscript("Um, uh, hmm.").accepted).toBe(false);
    expect(buffer.hasTranscript()).toBe(false);
  });
});
