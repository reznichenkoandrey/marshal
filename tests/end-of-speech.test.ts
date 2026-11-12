import { describe, expect, it } from "vitest";

import { EndOfSpeech, openMicAllowed, parseMeterLine, type EndOfSpeechOptions } from "../desktop/dictation/end-of-speech.ts";

const OPTIONS: EndOfSpeechOptions = { speechDb: -38, silenceMs: 900, noSpeechMs: 6000, minSpeechMs: 250, maxMs: 20_000 };

/** Feeds 100 ms readings and returns the first verdict with its time. */
function run(levels: number[]): { verdict: string | null; atMs: number } {
  const detector = new EndOfSpeech(OPTIONS);
  for (let i = 0; i < levels.length; i += 1) {
    const verdict = detector.feed(levels[i]!, i * 100);
    if (verdict) return { verdict, atMs: i * 100 };
  }
  return { verdict: null, atMs: -1 };
}

const quiet = (ms: number) => Array<number>(ms / 100).fill(-60);
const loud = (ms: number) => Array<number>(ms / 100).fill(-20);

describe("EndOfSpeech", () => {
  it("ends an answer after a pause that follows speech", () => {
    expect(run([...quiet(1000), ...loud(1200), ...quiet(2000)])).toEqual({ verdict: "answered", atMs: 3000 });
  });

  it("keeps listening through a short pause inside the answer", () => {
    const result = run([...loud(800), ...quiet(500), ...loud(800), ...quiet(2000)]);
    expect(result).toEqual({ verdict: "answered", atMs: 2900 });
  });

  it("gives up when nobody speaks", () => {
    expect(run(quiet(8000))).toEqual({ verdict: "silent", atMs: 6000 });
  });

  it("does not take a click for an answer", () => {
    expect(run([...quiet(500), -20, ...quiet(7000)])).toEqual({ verdict: "silent", atMs: 6000 });
  });

  it("stops a never-ending answer at the cap", () => {
    expect(run(loud(25_000)).verdict).toBe("answered");
  });
});

describe("parseMeterLine", () => {
  it("reads recorder meter lines and ignores the rest", () => {
    expect(parseMeterLine("level -23.4")).toBe(-23.4);
    expect(parseMeterLine("level -160.0\n")).toBe(-160);
    expect(parseMeterLine("ready")).toBeNull();
  });
});

describe("openMicAllowed", () => {
  const free = { asleep: false, meeting: false, captions: false, onCall: async () => false };

  it("lets the mic close itself when nothing else holds the owner", async () => {
    expect(await openMicAllowed(free)).toBe(true);
  });

  it("keeps the mic manual asleep, while recording a meeting, under captions and on a call", async () => {
    expect(await openMicAllowed({ ...free, asleep: true })).toBe(false);
    expect(await openMicAllowed({ ...free, meeting: true })).toBe(false);
    expect(await openMicAllowed({ ...free, captions: true })).toBe(false);
    expect(await openMicAllowed({ ...free, onCall: async () => true })).toBe(false);
  });

  it("does not run the call probe when a cheaper gate already says no", async () => {
    let probed = false;
    await openMicAllowed({ ...free, asleep: true, onCall: async () => (probed = true) });
    expect(probed).toBe(false);
  });
});
