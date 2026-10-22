// tests/meeting-assembly.test.ts
//
// "Finish" for interrupted and failed meeting recordings (#254): the plan of
// what is still on disk, WAV durations from headers a dead recorder never
// completed, and a full run over a real folder with the real ffmpeg.

import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MeetingAudioMixer } from "../desktop/meeting/audio-mixer.ts";
import { finishMeeting, planRecovery, wavDurationMs } from "../desktop/meeting/meeting-assembly.ts";
import type { MeetingChunkManifest, MeetingManifest } from "../desktop/meeting/meeting-recorder.ts";

function wav(seconds: number, rate = 16000, options: { zeroSizes?: boolean; extraChunk?: boolean } = {}): Buffer {
  const samples = Math.round(rate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), i * 2);
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  // AVAudioRecorder puts a FLLR padding chunk between fmt and data.
  const extra = options.extraChunk ? Buffer.concat([Buffer.from("FLLR"), Buffer.from([3, 0, 0, 0]), Buffer.alloc(4)]) : Buffer.alloc(0);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0);
  dataHeader.writeUInt32LE(options.zeroSizes ? 0 : data.length, 4);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0);
  riff.writeUInt32LE(options.zeroSizes ? 0 : 4 + fmt.length + extra.length + 8 + data.length, 4);
  riff.write("WAVE", 8);
  return Buffer.concat([riff, fmt, extra, dataHeader, data]);
}

function chunk(index: number, overrides: Partial<MeetingChunkManifest> = {}): MeetingChunkManifest {
  const name = `chunk-${String(index + 1).padStart(4, "0")}`;
  return {
    index,
    path: `/m/${name}.wav`,
    micPath: `/m/${name}-mic.wav`,
    systemPath: `/m/${name}-system.m4a`,
    startedAt: new Date(Date.UTC(2026, 9, 20, 17, 21, 55) + index * 300_000).toISOString(),
    ...overrides
  };
}

describe("planRecovery", () => {
  it("keeps finished chunks, re-mixes raw ones and sets aside chunks with no microphone file", () => {
    const sizes: Record<string, number> = {
      "/m/chunk-0001.wav": 28_000_000,
      "/m/chunk-0002-mic.wav": 9_000_000,
      "/m/chunk-0003-mic.wav": 44
    };
    const plan = planRecovery([chunk(0, { bytes: 28_000_000 }), chunk(1), chunk(2), chunk(3)], (p) => sizes[p] ?? null);

    expect(plan.ready.map((c) => c.index)).toEqual([0]);
    expect(plan.toMix.map((c) => c.index)).toEqual([1]);
    expect(plan.missing.map((c) => c.index)).toEqual([2, 3]);
  });

  it("re-mixes a chunk whose mix was cut short, even if the manifest has no bytes for it yet", () => {
    const sizes: Record<string, number> = { "/m/chunk-0001.wav": 1_000, "/m/chunk-0001-mic.wav": 9_000_000 };
    const plan = planRecovery([chunk(0)], (p) => sizes[p] ?? null);

    expect(plan.toMix.map((c) => c.index)).toEqual([0]);
  });
});

describe("wavDurationMs", () => {
  it("reads the duration from the byte rate", () => {
    const file = wav(2.5);
    expect(wavDurationMs(file, file.length)).toBeCloseTo(2500, 0);
  });

  it("measures by file size when the recorder died before writing the sizes", () => {
    const file = wav(3, 16000, { zeroSizes: true, extraChunk: true });
    expect(wavDurationMs(file.subarray(0, 4096), file.length)).toBeCloseTo(3000, 0);
  });

  it("returns null for something that is not a WAV", () => {
    expect(wavDurationMs(Buffer.from("not finalized"), 13)).toBeNull();
  });
});

const ffmpeg = MeetingAudioMixer.getBinaryPath();

describe.runIf(ffmpeg !== null)("finishMeeting", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), "marshal-finish-"));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function folderWith(manifest: Omit<MeetingManifest, "folder" | "chunks">, chunks: MeetingChunkManifest[]): Promise<string> {
    const folder = await fs.mkdtemp(path.join(root, "meeting-"));
    const relocated = chunks.map((c) => ({
      ...c,
      path: path.join(folder, path.basename(c.path)),
      micPath: path.join(folder, path.basename(c.micPath)),
      systemPath: c.systemPath ? path.join(folder, path.basename(c.systemPath)) : undefined
    }));
    await fs.writeFile(
      path.join(folder, "manifest.json"),
      JSON.stringify({ ...manifest, folder, chunks: relocated }, null, 2)
    );
    return folder;
  }

  it("finishes a failed save: keeps the mixed first chunk, rebuilds the second from the microphone (the 2026-10-20 case)", async () => {
    const startedAt = "2026-10-20T14:21:55.000Z";
    const folder = await folderWith(
      {
        id: "meeting-20261020-172155-b6436a90",
        mode: "audio",
        state: "error",
        source: "microphone+system",
        startedAt,
        stoppedAt: "2026-10-20T14:31:50.000Z",
        error: "ffmpeg meeting audio mix exited with code 1: moov atom not found"
      },
      [
        chunk(0, { startedAt, bytes: 1 }),
        chunk(1, { startedAt: "2026-10-20T14:21:57.000Z" })
      ]
    );
    // Chunk 1 was mixed during the call (48 kHz mono, like the recorder writes it).
    execFileSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", path.join(folder, "chunk-0001.wav")]);
    await fs.writeFile(path.join(folder, "chunk-0001-mic.wav"), wav(2));
    await fs.writeFile(path.join(folder, "chunk-0001-system.m4a"), "finalized but unused");
    // Chunk 2: an intact microphone track and a system track with no moov atom.
    await fs.writeFile(path.join(folder, "chunk-0002-mic.wav"), wav(1.5));
    await fs.writeFile(path.join(folder, "chunk-0002-system.m4a"), "not finalized");

    const manifest = await finishMeeting(folder);

    expect(manifest.state).toBe("done");
    expect(manifest.error).toBeUndefined();
    expect(manifest.audioPath && existsSync(manifest.audioPath)).toBe(true);
    expect(manifest.chunks).toEqual([]);
    expect(manifest.stoppedAt).toBe("2026-10-20T14:31:50.000Z");
    expect(manifest.warnings?.[0]).toContain("The save had failed: ffmpeg meeting audio mix exited with code 1");
    expect(manifest.warnings?.some((w) => w.startsWith("System audio for chunk 2 is unreadable; kept microphone only"))).toBe(true);
    const leftovers = (await fs.readdir(folder)).filter((name) => name.startsWith("chunk-"));
    expect(leftovers).toEqual([]);
    const stored = JSON.parse(await fs.readFile(path.join(folder, "manifest.json"), "utf8")) as MeetingManifest;
    expect(stored.state).toBe("done");
  }, 30_000);

  it("finishes an interrupted recording whose recorders never wrote their WAV sizes, and stamps when it ended", async () => {
    const startedAt = "2026-10-21T09:00:00.000Z";
    const folder = await folderWith(
      { id: "meeting-interrupted", mode: "audio", state: "recording", source: "microphone", startedAt },
      [chunk(0, { startedAt, systemPath: undefined })]
    );
    await fs.writeFile(path.join(folder, "chunk-0001-mic.wav"), wav(2, 16000, { zeroSizes: true, extraChunk: true }));

    const manifest = await finishMeeting(folder);

    expect(manifest.state).toBe("done");
    expect(manifest.audioPath && existsSync(manifest.audioPath)).toBe(true);
    // 2 s of audio from the start of the only chunk.
    expect(Date.parse(manifest.stoppedAt!) - Date.parse(startedAt)).toBeGreaterThan(1900);
    expect(Date.parse(manifest.stoppedAt!) - Date.parse(startedAt)).toBeLessThan(2100);
  }, 30_000);

  it("keeps the raw files of a chunk it could not use and says which", async () => {
    const startedAt = "2026-10-21T10:00:00.000Z";
    const folder = await folderWith(
      { id: "meeting-partial", mode: "audio", state: "recording", source: "microphone+system", startedAt },
      [chunk(0, { startedAt }), chunk(1, { startedAt: "2026-10-21T10:05:00.000Z" })]
    );
    await fs.writeFile(path.join(folder, "chunk-0001-mic.wav"), wav(1));
    await fs.writeFile(path.join(folder, "chunk-0002-system.m4a"), "only the system track survived");

    const manifest = await finishMeeting(folder);

    expect(manifest.chunks.map((c) => c.index)).toEqual([1]);
    expect(manifest.warnings).toEqual(expect.arrayContaining(["Chunks 2 are missing from the final audio; raw files kept in the folder."]));
    expect(existsSync(path.join(folder, "chunk-0002-system.m4a"))).toBe(true);
  }, 30_000);

  it("refuses a folder with nothing left to build from", async () => {
    const folder = await folderWith(
      { id: "meeting-empty", mode: "audio", state: "recording", source: "microphone", startedAt: "2026-10-21T11:00:00.000Z" },
      [chunk(0)]
    );

    await expect(finishMeeting(folder)).rejects.toThrow("No usable audio left");
    const stored = JSON.parse(await fs.readFile(path.join(folder, "manifest.json"), "utf8")) as MeetingManifest;
    expect(stored.state).toBe("recording");
  });
});
