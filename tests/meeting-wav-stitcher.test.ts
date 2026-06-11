import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readWavFormat, stitchWavPcm16Mono16k } from "../desktop/meeting/wav-stitcher.ts";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "marshal-meeting-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("stitchWavPcm16Mono16k", () => {
  it("concatenates PCM data and writes a valid WAV header", async () => {
    const first = path.join(tmpDir, "first.wav");
    const second = path.join(tmpDir, "second.wav");
    const out = path.join(tmpDir, "out.wav");
    await writeFile(first, makeWav(Buffer.from([1, 0, 2, 0])));
    await writeFile(second, makeWav(Buffer.from([3, 0, 4, 0, 5, 0])));

    const format = await stitchWavPcm16Mono16k([first, second], out);
    const stitched = await readFile(out);

    expect(format).toEqual({ sampleRate: 16_000, channels: 1, bitsPerSample: 16, dataBytes: 10 });
    expect(stitched.toString("ascii", 0, 4)).toBe("RIFF");
    expect(stitched.toString("ascii", 8, 12)).toBe("WAVE");
    expect(stitched.readUInt32LE(40)).toBe(10);
    expect([...stitched.subarray(44)]).toEqual([1, 0, 2, 0, 3, 0, 4, 0, 5, 0]);
    await expect(readWavFormat(out)).resolves.toEqual({
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 10
    });
  });

  it("rejects incompatible WAV chunks", async () => {
    const incompatible = path.join(tmpDir, "stereo.wav");
    const out = path.join(tmpDir, "out.wav");
    await writeFile(incompatible, makeWav(Buffer.from([1, 0]), { channels: 2 }));

    await expect(stitchWavPcm16Mono16k([incompatible], out)).rejects.toThrow(/Unsupported WAV format/);
  });

  it("rejects an empty input list", async () => {
    await expect(stitchWavPcm16Mono16k([], path.join(tmpDir, "out.wav"))).rejects.toThrow(
      /without WAV chunks/
    );
  });
});

function makeWav(
  pcm: Buffer,
  opts: { sampleRate?: number; channels?: number; bitsPerSample?: number } = {}
): Buffer {
  const sampleRate = opts.sampleRate ?? 16_000;
  const channels = opts.channels ?? 1;
  const bitsPerSample = opts.bitsPerSample ?? 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + pcm.length);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + pcm.length, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(pcm.length, 40);
  pcm.copy(buffer, 44);
  return buffer;
}
