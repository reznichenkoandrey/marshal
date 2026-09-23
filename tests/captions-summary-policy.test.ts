import { describe, expect, it } from "vitest";

import { decideSummaryAction } from "../desktop/captions/summary-policy.ts";
import { SpeechSegmenter, type SpeechSegment } from "../desktop/captions/segmenter.ts";

describe("decideSummaryAction (#189)", () => {
  it("starts when nothing is in flight, whatever the policy", () => {
    expect(decideSummaryAction({ policy: "interrupt", streaming: false })).toBe("start");
    expect(decideSummaryAction({ policy: "queue", streaming: false })).toBe("start");
  });

  it("restarts under interrupt and defers under queue while a summary streams", () => {
    expect(decideSummaryAction({ policy: "interrupt", streaming: true })).toBe("restart");
    expect(decideSummaryAction({ policy: "queue", streaming: true })).toBe("queue");
  });
});

const SAMPLE_RATE = 16_000;

function tone(ms: number, amplitude = 6000): Int16Array {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
  }
  return samples;
}

const silence = (ms: number): Int16Array => new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));

describe("SpeechSegmenter provisional cut (#189)", () => {
  it("emits a provisional copy at the short pause and the final at the real one, sharing the id", () => {
    const segments: SpeechSegment[] = [];
    const segmenter = new SpeechSegmenter((segment) => segments.push(segment), {
      silenceEndMs: 900,
      provisionalSilenceMs: 300
    });
    segmenter.pushSamples(silence(300));
    segmenter.pushSamples(tone(1_500));
    segmenter.pushSamples(silence(400));
    expect(segments.map((segment) => segment.reason)).toEqual(["provisional"]);
    segmenter.pushSamples(silence(700));
    expect(segments.map((segment) => segment.reason)).toEqual(["provisional", "silence"]);
    const [provisional, final] = segments;
    expect(final.utteranceId).toBe(provisional.utteranceId);
    // No speech followed the provisional copy, so the consumer may reuse its transcript.
    expect(final.speechMs).toBe(provisional.speechMs);
  });

  it("sends another provisional after speech resumes, and the final then has more speech", () => {
    const segments: SpeechSegment[] = [];
    const segmenter = new SpeechSegmenter((segment) => segments.push(segment), {
      silenceEndMs: 900,
      provisionalSilenceMs: 300
    });
    segmenter.pushSamples(tone(1_000));
    segmenter.pushSamples(silence(400)); // provisional #1
    segmenter.pushSamples(tone(800)); // speech resumes → utterance continues
    segmenter.pushSamples(silence(1_000)); // provisional #2, then final
    expect(segments.map((segment) => segment.reason)).toEqual(["provisional", "provisional", "silence"]);
    const ids = new Set(segments.map((segment) => segment.utteranceId));
    expect(ids.size).toBe(1);
    expect(segments[0].speechMs).toBeLessThan(segments[2].speechMs);
    expect(segments[1].speechMs).toBe(segments[2].speechMs);
  });

  it("never sends a provisional when disabled, and numbers utterances", () => {
    const segments: SpeechSegment[] = [];
    const segmenter = new SpeechSegmenter((segment) => segments.push(segment), { silenceEndMs: 650 });
    segmenter.pushSamples(tone(1_000));
    segmenter.pushSamples(silence(1_000));
    segmenter.pushSamples(tone(1_000));
    segmenter.pushSamples(silence(1_000));
    expect(segments.map((segment) => segment.reason)).toEqual(["silence", "silence"]);
    expect(segments[1].utteranceId).toBe(segments[0].utteranceId + 1);
  });
});
