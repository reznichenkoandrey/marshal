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
