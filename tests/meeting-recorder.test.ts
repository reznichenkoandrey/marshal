// tests/meeting-recorder.test.ts
//
// Meeting capture across chunk rotations (#250, #251). The Swift helpers are
// replaced by small Node scripts that speak the same stdin/stdout protocol, so
// the process lifecycle — exits arriving after the next helper was spawned —
// runs for real. ffmpeg is the real one from ffmpeg-static.

import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { MeetingAudioMixer } from "../desktop/meeting/audio-mixer.ts";
import { MeetingRecorder, type MeetingManifest } from "../desktop/meeting/meeting-recorder.ts";
import { SystemAudioRecorder } from "../desktop/meeting/system-audio-recorder.ts";

const WAV_WRITER = `
function writeWav(file, seconds) {
  const rate = 16000;
  const samples = Math.max(1, Math.round(rate * seconds));
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  require("node:fs").writeFileSync(file, Buffer.concat([header, data]));
}
`;

// audio-recorder: announces readiness on stdout, writes the WAV on SIGTERM.
const FAKE_MIC = `#!/usr/bin/env node
${WAV_WRITER}
const out = process.argv[2];
const started = Date.now();
process.on("SIGTERM", () => { writeWav(out, (Date.now() - started) / 1000); process.exit(0); });
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;

// system-audio-recorder: like AVAssetWriter, the file is unreadable (no moov)
// until "stop" finalizes it. FAKE_SYSTEM_EXIT_AFTER_MS simulates a crash,
// FAKE_SYSTEM_STOP_ERROR a stop the helper refuses.
const FAKE_SYSTEM = `#!/usr/bin/env node
${WAV_WRITER}
let out = null;
let started = 0;
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const [cmd, ...rest] = line.trim().split(" ");
  if (cmd === "start") {
    out = rest.join(" ");
    started = Date.now();
    require("node:fs").writeFileSync(out, "not finalized");
    process.stdout.write("started\\n");
    const crashAfter = Number(process.env.FAKE_SYSTEM_EXIT_AFTER_MS || 0);
    if (crashAfter > 0) setTimeout(() => process.exit(3), crashAfter);
  } else if (cmd === "stop") {
    if (process.env.FAKE_SYSTEM_STOP_ERROR) { process.stdout.write("error stop refused\\n"); return; }
    writeWav(out, (Date.now() - started) / 1000);
    process.stdout.write("stopped " + out + "\\n");
  } else if (cmd === "quit") {
    process.exit(0);
  }
});
rl.on("close", () => process.exit(0));
`;

class TestSystemAudioRecorder extends SystemAudioRecorder {
  override isAvailable(): boolean {
    return true;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let workDir: string;
let micBin: string;
let systemBin: string;
const savedEnv = { ...process.env };

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(tmpdir(), "marshal-meeting-"));
  micBin = path.join(workDir, "fake-audio-recorder");
  systemBin = path.join(workDir, "fake-system-audio-recorder");
  await fs.writeFile(micBin, FAKE_MIC, { mode: 0o755 });
  await fs.writeFile(systemBin, FAKE_SYSTEM, { mode: 0o755 });
});

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.FAKE_SYSTEM_EXIT_AFTER_MS;
  delete process.env.FAKE_SYSTEM_STOP_ERROR;
  process.env.MARSHAL_DICTATION_MIC = savedEnv.MARSHAL_DICTATION_MIC;
  if (savedEnv.MARSHAL_DICTATION_MIC === undefined) delete process.env.MARSHAL_DICTATION_MIC;
});

describe("SystemAudioRecorder", () => {
  it("keeps the handle to the new helper when the previous one exits after it was spawned (#250)", async () => {
    const recorder = new TestSystemAudioRecorder(systemBin);
    const first = path.join(workDir, "first.m4a");
    const second = path.join(workDir, "second.m4a");

    await recorder.start(first);
    await recorder.stop();
    await recorder.start(second);
    // Let the first helper's exit (from "quit") arrive.
    await sleep(300);

    expect(recorder.isRecording()).toBe(true);
    await expect(recorder.stop()).resolves.toBe(second);
    expect((await fs.readFile(second)).subarray(0, 4).toString()).toBe("RIFF");
  });

  it("reports a helper that dies mid-recording instead of staying silent", async () => {
    process.env.FAKE_SYSTEM_EXIT_AFTER_MS = "100";
    const recorder = new TestSystemAudioRecorder(systemBin);
    const failed = new Promise<string>((resolve) => recorder.once("failed", resolve));

    await recorder.start(path.join(workDir, "crash.m4a"));

    await expect(failed).resolves.toMatch(/exited while recording \(3\)/);
    expect(recorder.isRecording()).toBe(false);
  });

  it("does not report a helper it stopped itself", async () => {
    const recorder = new TestSystemAudioRecorder(systemBin);
    let failures = 0;
    recorder.on("failed", () => failures++);

    await recorder.start(path.join(workDir, "clean.m4a"));
    await recorder.stop();
    await sleep(200);

    expect(failures).toBe(0);
  });

  it("rejects a stop the helper refuses instead of waiting forever", async () => {
    process.env.FAKE_SYSTEM_STOP_ERROR = "1";
    const recorder = new TestSystemAudioRecorder(systemBin);

    await recorder.start(path.join(workDir, "refused.m4a"));

    await expect(recorder.stop()).rejects.toThrow("stop refused");
    expect(recorder.isRecording()).toBe(false);
  });
});

const hasFfmpeg = MeetingAudioMixer.getBinaryPath() !== null;

describe.runIf(hasFfmpeg)("MeetingRecorder across chunk rotations", () => {
  async function record(
    createSystemAudioRecorder: () => SystemAudioRecorder | null,
    durationMs: number
  ): Promise<{ manifest: MeetingManifest; warnings: string[]; audioPath: string | null; folder: string }> {
    delete process.env.MARSHAL_DICTATION_MIC;
    const userDataDir = await fs.mkdtemp(path.join(workDir, "userdata-"));
    const recorder = new MeetingRecorder({ userDataDir, recorderBin: micBin, chunkMs: 600, createSystemAudioRecorder });
    const warnings: string[] = [];
    recorder.on("warning", (message) => warnings.push(message));
    recorder.on("error", () => undefined);

    const { folder } = await recorder.start("audio");
    await sleep(durationMs);
    const session = await recorder.stop();
    const manifest = JSON.parse(await fs.readFile(path.join(folder, "manifest.json"), "utf8")) as MeetingManifest;
    return { manifest, warnings, audioPath: session?.audioPath ?? null, folder };
  }

  it("mixes system audio into every chunk, not only the first (#250)", async () => {
    const { manifest, warnings, audioPath, folder } = await record(() => new TestSystemAudioRecorder(systemBin), 2000);

    expect(manifest.source).toBe("microphone+system");
    expect(warnings).toEqual([]);
    expect(manifest.state).toBe("done");
    expect(audioPath && existsSync(audioPath)).toBe(true);
    // Raw chunks are gone only because all of them made it into meeting.m4a.
    const left = (await fs.readdir(folder)).filter((name) => name.startsWith("chunk-"));
    expect(left).toEqual([]);
  }, 30_000);

  it("keeps the microphone when a chunk's system audio is unreadable (#251)", async () => {
    // Every chunk's helper dies before "stop", so no system file is ever finalized.
    process.env.FAKE_SYSTEM_EXIT_AFTER_MS = "200";
    const { manifest, warnings, audioPath } = await record(() => new TestSystemAudioRecorder(systemBin), 1500);

    expect(manifest.state).toBe("done");
    expect(audioPath && existsSync(audioPath)).toBe(true);
    expect(warnings.some((message) => message.startsWith("System audio stopped during chunk-0001"))).toBe(true);
    expect(warnings.some((message) => /System audio for chunk \d+ is unreadable; kept microphone only/.test(message))).toBe(true);
    expect(manifest.warnings ?? []).toEqual(expect.arrayContaining(warnings));
  }, 30_000);
});
