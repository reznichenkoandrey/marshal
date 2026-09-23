import { describe, expect, it } from "vitest";

import { frameRms, SpeechSegmenter, type SpeechSegment } from "../desktop/captions/segmenter.ts";

const SAMPLE_RATE = 16_000;

function tone(ms: number, amplitude: number, frequency = 440): Int16Array {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE));
  }
  return samples;
}

function silence(ms: number, noise = 0): Int16Array {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  if (noise > 0) {
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.round((Math.random() * 2 - 1) * noise);
    }
  }
  return samples;
}

function collect(): { segments: SpeechSegment[]; segmenter: SpeechSegmenter } {
  const segments: SpeechSegment[] = [];
  const segmenter = new SpeechSegmenter((segment) => segments.push(segment));
  return { segments, segmenter };
}

describe("frameRms", () => {
  it("is zero for silence and scales with amplitude", () => {
    expect(frameRms(silence(20))).toBe(0);
    const loud = frameRms(tone(20, 8000));
    const quiet = frameRms(tone(20, 800));
    expect(loud).toBeGreaterThan(quiet * 5);
  });
});

describe("SpeechSegmenter", () => {
  it("cuts an utterance once the speaker pauses, keeping a little pre-roll", () => {
    const { segments, segmenter } = collect();
    segmenter.pushSamples(silence(500));
    segmenter.pushSamples(tone(1_200, 6000));
    segmenter.pushSamples(silence(900));

    expect(segments).toHaveLength(1);
    const [segment] = segments;
    expect(segment.reason).toBe("silence");
    expect(segment.speechMs).toBeGreaterThanOrEqual(1_100);
    // Pre-roll (240 ms) + speech (1200 ms) + kept tail (≈325 ms), never the full pause.
    const durationMs = (segment.samples.length / SAMPLE_RATE) * 1000;
    expect(durationMs).toBeGreaterThan(1_400);
    expect(durationMs).toBeLessThan(1_900);
  });

  it("ignores a blip shorter than the minimum utterance", () => {
    const { segments, segmenter } = collect();
    segmenter.pushSamples(silence(300));
    segmenter.pushSamples(tone(200, 6000));
    segmenter.pushSamples(silence(1_000));
    expect(segments).toHaveLength(0);
  });

  it("emits on the hard cap when the speaker never pauses", () => {
    const { segments, segmenter } = collect();
    segmenter.pushSamples(tone(20_000, 6000));
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[0].reason).toBe("max-length");
    const durationMs = (segments[0].samples.length / SAMPLE_RATE) * 1000;
    expect(durationMs).toBeLessThanOrEqual(9_000);
  });

  it("does not treat steady background noise as speech", () => {
    const { segments, segmenter } = collect();
    segmenter.pushSamples(silence(4_000, 200));
    expect(segments).toHaveLength(0);
    expect(segmenter.isInSpeech).toBe(false);
  });

  it("accepts raw bytes split at odd boundaries", () => {
    const { segments, segmenter } = collect();
    const pcm = new Int16Array([...silence(300), ...tone(1_000, 6000), ...silence(900)]);
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    // Feed in chunks of 1001 bytes so every chunk ends mid-sample.
    for (let offset = 0; offset < bytes.length; offset += 1001) {
      segmenter.pushBytes(bytes.subarray(offset, Math.min(offset + 1001, bytes.length)));
    }
    expect(segments).toHaveLength(1);
  });

  it("lets an injected classifier veto frames the energy gate would take", () => {
    const { segments, segmenter } = collect();
    // Override the constructor's listener with a classifier-driven one.
    const vetoed: SpeechSegment[] = [];
    const strict = new SpeechSegmenter((segment) => vetoed.push(segment), { classifyFrame: () => false });
    const permissive = new SpeechSegmenter((segment) => segments.push(segment), { classifyFrame: () => true });
    for (const target of [strict, permissive]) {
      target.pushSamples(silence(300));
      target.pushSamples(tone(1_200, 6000));
      target.pushSamples(silence(900));
    }
    expect(vetoed).toHaveLength(0);
    expect(segments).toHaveLength(1);
    // The absolute floor still applies with a classifier: near-silence is never speech.
    const quiet = new SpeechSegmenter((segment) => vetoed.push(segment), { classifyFrame: () => true });
    quiet.pushSamples(silence(2_000, 50));
    expect(vetoed).toHaveLength(0);
    void segmenter;
  });

  it("flushes speech in progress on stop", () => {
    const { segments, segmenter } = collect();
    segmenter.pushSamples(tone(1_000, 6000));
    expect(segments).toHaveLength(0);
    segmenter.flush();
    expect(segments).toHaveLength(1);
    expect(segments[0].reason).toBe("flush");
  });
});

describe("SpeechSegmenter with a classifier (#202)", () => {
  /** Silero-like stand-in: everything the test feeds it is speech. */
  const alwaysSpeech = (): boolean => true;

  function collectClassified(options = {}): { segments: SpeechSegment[]; segmenter: SpeechSegmenter } {
    const segments: SpeechSegment[] = [];
    const segmenter = new SpeechSegmenter((segment) => segments.push(segment), {
      classifyFrame: alwaysSpeech,
      silenceEndMs: 900,
      ...options
    });
    return { segments, segmenter };
  }

  it("keeps a sentence whose middle goes quiet as one segment", () => {
    const { segments, segmenter } = collectClassified();
    // Amplitude 200 sits under the energy-mode floor (350) and above the
    // classifier floor (120) — a softly speaking participant. Before #202
    // this stretch counted as silence and closed the utterance mid-sentence.
    segmenter.pushSamples(tone(700, 6000));
    segmenter.pushSamples(tone(1_200, 200));
    segmenter.pushSamples(tone(700, 6000));
    expect(segments).toHaveLength(0);

    segmenter.pushSamples(silence(1_000));
    expect(segments).toHaveLength(1);
    expect(segments[0].reason).toBe("silence");
  });

  it("still ignores digital silence the classifier calls speech", () => {
    const { segments, segmenter } = collectClassified();
    segmenter.pushSamples(silence(2_000));
    expect(segments).toHaveLength(0);
    expect(segmenter.isInSpeech).toBe(false);
  });

  it("honours a raised floor, so a noisy room can be tuned back up", () => {
    const { segments, segmenter } = collectClassified({ classifierMinRms: 350 });
    segmenter.pushSamples(tone(700, 6000));
    segmenter.pushSamples(tone(1_200, 200)); // now below the floor again
    segmenter.pushSamples(tone(700, 6000));
    // The quiet stretch is long enough to close the first half on its own.
    expect(segments.length).toBeGreaterThanOrEqual(1);
  });
});

describe("SpeechSegmenter partial copies (#203)", () => {
  function collectPartials(options = {}): { segments: SpeechSegment[]; segmenter: SpeechSegmenter } {
    const segments: SpeechSegment[] = [];
    const segmenter = new SpeechSegmenter((segment) => segments.push(segment), {
      silenceEndMs: 900,
      partialIntervalMs: 1_000,
      ...options
    });
    return { segments, segmenter };
  }

  it("emits a partial roughly every interval while speech goes on", () => {
    const { segments, segmenter } = collectPartials();
    segmenter.pushSamples(tone(3_500, 6000));

    const partials = segments.filter((segment) => segment.reason === "partial");
    expect(partials.length).toBe(3);
    // One utterance: every partial belongs to it.
    expect(new Set(partials.map((segment) => segment.utteranceId)).size).toBe(1);
    // Until the utterance outgrows the window, each copy holds everything so far.
    expect(partials[1].samples.length).toBeGreaterThan(partials[0].samples.length);
  });

  it("shares the utterance id with the final segment", () => {
    const { segments, segmenter } = collectPartials();
    segmenter.pushSamples(tone(2_200, 6000));
    segmenter.pushSamples(silence(1_000));

    const partial = segments.find((segment) => segment.reason === "partial");
    const final = segments.find((segment) => segment.reason === "silence");
    expect(partial).toBeDefined();
    expect(final?.utteranceId).toBe(partial?.utteranceId);
  });

  it("does not emit partials during the pause — that is provisional's job", () => {
    const { segments, segmenter } = collectPartials({ partialIntervalMs: 500 });
    segmenter.pushSamples(tone(600, 6000));
    const before = segments.filter((segment) => segment.reason === "partial").length;
    segmenter.pushSamples(silence(850)); // under silenceEndMs, utterance still open
    const after = segments.filter((segment) => segment.reason === "partial").length;
    expect(after).toBe(before);
  });

  it("starts counting again for the next utterance", () => {
    const { segments, segmenter } = collectPartials();
    segmenter.pushSamples(tone(1_500, 6000));
    segmenter.pushSamples(silence(1_000));
    segmenter.pushSamples(tone(1_500, 6000));

    const ids = segments.filter((segment) => segment.reason === "partial").map((segment) => segment.utteranceId);
    expect(ids).toEqual([1, 2]);
  });

  it("is off by default", () => {
    const { segments, segmenter } = collect();
    segmenter.pushSamples(tone(5_000, 6000));
    expect(segments.some((segment) => segment.reason === "partial")).toBe(false);
  });

  it("waits for the minimum speech length before the first partial", () => {
    const { segments, segmenter } = collectPartials({ partialIntervalMs: 200, minSpeechMs: 450 });
    segmenter.pushSamples(tone(300, 6000));
    expect(segments.some((segment) => segment.reason === "partial")).toBe(false);
  });
});

describe("SpeechSegmenter partial window (#207)", () => {
  const RATE = 16_000;

  it("caps a partial at the window while the final keeps the whole utterance", () => {
    const segments: SpeechSegment[] = [];
    const segmenter = new SpeechSegmenter((segment) => segments.push(segment), {
      silenceEndMs: 900,
      partialIntervalMs: 1_000,
      partialWindowMs: 3_000
    });
    // 8 s, under the 9 s segment cap, so the utterance closes on the pause.
    segmenter.pushSamples(tone(8_000, 6000));
    segmenter.pushSamples(silence(1_000));

    const partials = segments.filter((segment) => segment.reason === "partial");
    const final = segments.find((segment) => segment.reason === "silence");
    expect(final).toBeDefined();
    expect(partials.length).toBeGreaterThanOrEqual(6);
    // Constant cost per pass: no partial carries more than the window.
    for (const partial of partials) {
      expect(partial.samples.length).toBeLessThanOrEqual(RATE * 3);
    }
    // The ones taken late in the sentence are exactly the window.
    expect(partials[partials.length - 1].samples.length).toBe(RATE * 3);
    // The final is untouched: every word of the sentence still gets transcribed.
    expect(final!.samples.length).toBeGreaterThan(RATE * 8);
  });

  it("sends a whole utterance when the window is off", () => {
    const segments: SpeechSegment[] = [];
    const segmenter = new SpeechSegmenter((segment) => segments.push(segment), {
      partialIntervalMs: 1_000,
      partialWindowMs: 0
    });
    segmenter.pushSamples(tone(5_000, 6000));
    const partials = segments.filter((segment) => segment.reason === "partial");
    expect(partials[partials.length - 1].samples.length).toBeGreaterThan(RATE * 4);
  });

  it("adds up to linear audio cost over a long sentence", () => {
    // The #207 arithmetic, pinned: before the window a 9 s sentence sent
    // ~36 s of partial audio; with a 3 s window it cannot exceed 3 s per pass.
    const segments: SpeechSegment[] = [];
    const segmenter = new SpeechSegmenter((segment) => segments.push(segment), {
      partialIntervalMs: 1_000,
      partialWindowMs: 3_000
    });
    segmenter.pushSamples(tone(9_000, 6000));
    const partialSeconds = segments
      .filter((segment) => segment.reason === "partial")
      .reduce((sum, segment) => sum + segment.samples.length / RATE, 0);
    expect(partialSeconds).toBeLessThanOrEqual(8 * 3);
    expect(partialSeconds).toBeLessThan(30);
  });
});
