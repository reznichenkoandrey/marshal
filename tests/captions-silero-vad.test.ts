import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SpeechSegmenter } from "../desktop/captions/segmenter.ts";
import { SileroVad } from "../desktop/captions/silero-vad.ts";

const SAMPLE_RATE = 16_000;
const FRAME = 320; // 20 ms, what the segmenter feeds

function loadFixture(): Int16Array {
  const wav = readFileSync(path.join(process.cwd(), "tests", "fixtures", "speech-16k.wav"));
  const data = wav.subarray(44);
  return new Int16Array(data.buffer, data.byteOffset, data.length / 2);
}

function noise(ms: number, amplitude: number, seed = 7): Int16Array {
  // Deterministic LCG so the test cannot flake on a lucky draw.
  let state = seed;
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let i = 0; i < samples.length; i += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    samples[i] = Math.round(((state / 0xffff_ffff) * 2 - 1) * amplitude);
  }
  return samples;
}

function tone(ms: number, amplitude: number, frequency: number): Int16Array {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE));
  }
  return samples;
}

/** Feeds 20 ms frames, waits for inference, returns the share of frames judged speech. */
async function speechShare(vad: SileroVad, samples: Int16Array): Promise<number> {
  let speech = 0;
  let total = 0;
  for (let i = 0; i + FRAME <= samples.length; i += FRAME) {
    vad.classify(samples.subarray(i, i + FRAME));
    // Let the background scorer catch up so the decision is not stale.
    await vad.settle();
    if (vad.classify(new Int16Array(0))) speech += 1;
    total += 1;
  }
  await vad.settle();
  return speech / total;
}

describe("Silero VAD (onnxruntime-web)", () => {
  it("scores real speech high and noise, a tone and silence low", async () => {
    const vad = await SileroVad.create();
    expect(await speechShare(vad, loadFixture())).toBeGreaterThan(0.7);
    vad.reset();
    expect(await speechShare(vad, noise(2_000, 6_000))).toBe(0);
    vad.reset();
    expect(await speechShare(vad, tone(1_000, 8_000, 440))).toBe(0);
    vad.reset();
    expect(await speechShare(vad, new Int16Array(SAMPLE_RATE))).toBe(0);
    vad.dispose();
  }, 30_000);

  it("is inert after dispose", async () => {
    const vad = await SileroVad.create();
    vad.dispose();
    expect(vad.classify(new Int16Array(FRAME))).toBe(false);
    vad.dispose();
  });
});

describe("SpeechSegmenter with the Silero classifier", () => {
  it("drops a loud noise burst that the energy gate alone would cut into a segment", async () => {
    const vad = await SileroVad.create();
    const withVad: number[] = [];
    const segmenter = new SpeechSegmenter((segment) => withVad.push(segment.speechMs), {
      classifyFrame: (frame) => vad.classify(frame)
    });
    const burst = noise(1_500, 6_000);
    for (let i = 0; i + FRAME <= burst.length; i += FRAME) {
      segmenter.pushSamples(burst.subarray(i, i + FRAME));
      await vad.settle();
    }
    segmenter.pushSamples(new Int16Array(SAMPLE_RATE));
    await vad.settle();
    vad.dispose();

    const energyOnly: number[] = [];
    const plain = new SpeechSegmenter((segment) => energyOnly.push(segment.speechMs));
    plain.pushSamples(new Int16Array(SAMPLE_RATE / 2));
    plain.pushSamples(burst);
    plain.pushSamples(new Int16Array(SAMPLE_RATE));

    expect(energyOnly).toHaveLength(1);
    expect(withVad).toHaveLength(0);
  }, 30_000);

  it("segments real speech and honours a longer silence threshold", async () => {
    const vad = await SileroVad.create();
    const cuts: string[] = [];
    const segmenter = new SpeechSegmenter((segment) => cuts.push(segment.reason), {
      classifyFrame: (frame) => vad.classify(frame),
      silenceEndMs: 1_400
    });
    const feed = async (samples: Int16Array): Promise<void> => {
      for (let i = 0; i + FRAME <= samples.length; i += FRAME) {
        segmenter.pushSamples(samples.subarray(i, i + FRAME));
        await vad.settle();
      }
    };
    await feed(loadFixture());
    // A 1 s pause must NOT close the utterance at a 1.4 s threshold…
    await feed(new Int16Array(SAMPLE_RATE));
    expect(cuts).toEqual([]);
    // …but 1.5 s of silence in total does.
    await feed(new Int16Array(SAMPLE_RATE / 2));
    expect(cuts).toEqual(["silence"]);
    vad.dispose();
  }, 30_000);
});
