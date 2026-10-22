// Turns a meeting folder's raw chunks into meeting.m4a (and meeting.mp4).
// MeetingRecorder.stop() and "Finish" on an interrupted or failed recording
// (#254) run the same code, so a recording finished after a crash is built
// exactly like one that was stopped normally.

import { promises as fs } from "node:fs";
import path from "node:path";

import { buildMeetingMuxArgs, buildTimelineToAacArgs, MeetingAudioMixer } from "./audio-mixer.ts";
import type { MeetingChunkManifest, MeetingManifest } from "./meeting-recorder.ts";

export const MEETING_AUDIO_FILE = "meeting.m4a";
export const MEETING_VIDEO_FILE = "meeting.mp4";
export const RAW_SCREEN_FILE = "screen.mov";
const MANIFEST_FILE = "manifest.json";
// A WAV that holds nothing but its header has no audio to keep.
const MIN_WAV_BYTES = 44;

type Warn = (message: string) => void;

type ChunkFiles = Pick<MeetingChunkManifest, "index" | "path" | "micPath" | "systemPath">;

/**
 * Mixes one chunk's microphone and system tracks into its chunk WAV. The
 * microphone file is intact even when the system track is not (helper
 * crashed, file never finalized): that chunk keeps the user's side of the
 * call instead of failing (#251). Returns the size of the written WAV.
 */
export async function mixChunk(chunk: ChunkFiles, warn: Warn): Promise<number> {
  try {
    await MeetingAudioMixer.mix({ micPath: chunk.micPath, systemPath: chunk.systemPath, outputPath: chunk.path });
  } catch (err) {
    if (!chunk.systemPath) throw err;
    const message = err instanceof Error ? err.message : String(err);
    warn(`System audio for chunk ${chunk.index + 1} is unreadable; kept microphone only. ${message}`);
    await MeetingAudioMixer.mix({ micPath: chunk.micPath, outputPath: chunk.path });
  }
  const stat = await fs.stat(chunk.path).catch(() => null);
  return stat?.size ?? 0;
}

export type AssembleMeetingInput = {
  folder: string;
  chunks: MeetingChunkManifest[];
  rawVideoPath: string | null;
  videoStartedAt?: string;
  warn: Warn;
};

export type AssembledMeeting = {
  audioPath: string;
  videoPath?: string;
  /** Chunks missing from the final audio; their raw files stay in the folder. */
  left: MeetingChunkManifest[];
};

/**
 * Lays the mixed chunks on the wall-clock timeline, muxes the screen video if
 * there is one, and only then removes the raw files that made it in: until
 * the final files exist, the raw ones are the only copy of the call.
 */
export async function assembleMeeting(input: AssembleMeetingInput): Promise<AssembledMeeting> {
  const recorded = input.chunks.filter((chunk) => (chunk.bytes ?? 0) > 0);
  if (recorded.length === 0) throw new Error("No audio was recorded.");
  const timelineStart = Date.parse(recorded[0].startedAt);
  const audioPath = path.join(input.folder, MEETING_AUDIO_FILE);
  await MeetingAudioMixer.run(
    buildTimelineToAacArgs(
      recorded.map((chunk) => ({ path: chunk.path, offsetMs: Date.parse(chunk.startedAt) - timelineStart })),
      audioPath
    ),
    "meeting audio assembly"
  );

  let videoPath: string | undefined;
  if (input.rawVideoPath && input.videoStartedAt) {
    const target = path.join(input.folder, MEETING_VIDEO_FILE);
    try {
      await MeetingAudioMixer.run(
        buildMeetingMuxArgs({
          videoPath: input.rawVideoPath,
          audioPath,
          audioOffsetSec: (timelineStart - Date.parse(input.videoStartedAt)) / 1000,
          outputPath: target
        }),
        "meeting video mux"
      );
      videoPath = target;
      await fs.rm(input.rawVideoPath, { force: true });
    } catch (err) {
      // The audio is the call; a video that will not mux must not take it down.
      const message = err instanceof Error ? err.message : String(err);
      input.warn(`Screen video could not be combined with the audio; ${RAW_SCREEN_FILE} kept in the folder. ${message}`);
    }
  }

  await Promise.all(
    recorded.flatMap((chunk) =>
      [chunk.path, chunk.micPath, chunk.systemPath]
        .filter((p): p is string => Boolean(p))
        .map((p) => fs.rm(p, { force: true }))
    )
  );
  const left = input.chunks.filter((chunk) => !recorded.includes(chunk));
  if (left.length > 0) {
    input.warn(`Chunks ${left.map((chunk) => chunk.index + 1).join(", ")} are missing from the final audio; raw files kept in the folder.`);
  }
  return { audioPath, videoPath, left };
}

export type RecoveryPlan = {
  /** Chunks whose mixed WAV was finished before the recording stopped. */
  ready: MeetingChunkManifest[];
  /** Chunks that only have their raw tracks and must be mixed now. */
  toMix: MeetingChunkManifest[];
  /** Chunks with no usable microphone file. */
  missing: MeetingChunkManifest[];
};

/** Sorts an unfinished recording's chunks by what is still on disk. */
export function planRecovery(
  chunks: MeetingChunkManifest[],
  fileSize: (filePath: string) => number | null
): RecoveryPlan {
  const plan: RecoveryPlan = { ready: [], toMix: [], missing: [] };
  for (const chunk of chunks) {
    if ((chunk.bytes ?? 0) > 0 && (fileSize(chunk.path) ?? 0) > MIN_WAV_BYTES) plan.ready.push(chunk);
    else if ((fileSize(chunk.micPath) ?? 0) > MIN_WAV_BYTES) plan.toMix.push(chunk);
    else plan.missing.push(chunk);
  }
  return plan;
}

/**
 * Duration of a PCM WAV from its header and the real file size. The size
 * fields can't be trusted: a recorder that died never wrote them, and ffmpeg
 * reads such a file to its end anyway, so this does the same.
 */
export function wavDurationMs(header: Buffer, fileSize: number): number | null {
  if (header.length < 12 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= header.length) {
    const id = header.toString("ascii", offset, offset + 4);
    const size = header.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 16 <= header.length) byteRate = header.readUInt32LE(offset + 16);
    if (id === "data") {
      if (byteRate <= 0) return null;
      return (Math.max(0, fileSize - (offset + 8)) / byteRate) * 1000;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

async function wavFileDurationMs(filePath: string): Promise<number | null> {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) return null;
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const { size } = await handle.stat();
    return wavDurationMs(header.subarray(0, bytesRead), size);
  } finally {
    await handle.close();
  }
}

/**
 * Builds the final files of a recording that never reached them — Marshal
 * crashed or was killed mid-call ("Interrupted"), or the save failed
 * ("Failed"). Uses whatever raw chunks are still in the folder.
 */
export async function finishMeeting(folder: string): Promise<MeetingManifest> {
  const manifestPath = path.join(folder, MANIFEST_FILE);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as MeetingManifest;
  const sizes = new Map<string, number | null>();
  await Promise.all(
    manifest.chunks.flatMap((chunk) => [chunk.path, chunk.micPath]).map(async (p) => {
      sizes.set(p, (await fs.stat(p).catch(() => null))?.size ?? null);
    })
  );
  const plan = planRecovery(manifest.chunks, (p) => sizes.get(p) ?? null);
  if (plan.ready.length + plan.toMix.length === 0) {
    throw new Error("No usable audio left in this recording's folder.");
  }
  // Whatever bytes a missing chunk once claimed, there is no file behind it now.
  for (const chunk of plan.missing) chunk.bytes = 0;

  const warnings: string[] = [];
  const warn: Warn = (message) => warnings.push(message);
  for (const chunk of plan.toMix) {
    chunk.systemPath = chunk.systemPath && (await exists(chunk.systemPath)) ? chunk.systemPath : undefined;
    chunk.bytes = await mixChunk(chunk, warn);
  }

  // The timeline end, measured before assembleMeeting deletes the chunk WAVs:
  // an interrupted recording never stamped its own stop time.
  let endMs = Date.parse(manifest.startedAt);
  for (const chunk of [...plan.ready, ...plan.toMix]) {
    const duration = await wavFileDurationMs(chunk.path);
    if (duration !== null) endMs = Math.max(endMs, Date.parse(chunk.startedAt) + duration);
  }

  const rawVideoPath = path.join(folder, RAW_SCREEN_FILE);
  const assembled = await assembleMeeting({
    folder,
    chunks: manifest.chunks,
    rawVideoPath: (await exists(rawVideoPath)) ? rawVideoPath : null,
    videoStartedAt: manifest.videoStartedAt,
    warn
  });

  const previous = manifest.state === "error" && manifest.error ? ` The save had failed: ${manifest.error}` : "";
  manifest.warnings = [
    ...(manifest.warnings ?? []),
    `Finished from raw chunks after the recording was interrupted.${previous}`,
    ...warnings
  ];
  manifest.stoppedAt ??= new Date(endMs).toISOString();
  manifest.audioPath = assembled.audioPath;
  manifest.videoPath = assembled.videoPath;
  manifest.chunks = assembled.left;
  manifest.state = "done";
  delete manifest.error;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

async function exists(filePath: string): Promise<boolean> {
  return (await fs.stat(filePath).catch(() => null)) !== null;
}
