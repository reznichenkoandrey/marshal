import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

const localRequire = createRequire(import.meta.url);

// Recordings are for listening back, not for Whisper: 48 kHz keeps voices
// natural; mono because a call mix has no meaningful stereo image.
const PLAYBACK_SAMPLE_RATE = "48000";
const AAC_BITRATE = "96k";

export type MixMeetingAudioInput = {
  micPath: string;
  systemPath?: string;
  outputPath: string;
};

export type MuxMeetingInput = {
  videoPath: string;
  audioPath: string;
  /** Seconds the audio started after the video; negative when it started first. */
  audioOffsetSec: number;
  outputPath: string;
};

export function buildMeetingAudioMixArgs(input: MixMeetingAudioInput): string[] {
  if (!input.systemPath) {
    return [
      "-y",
      "-i", input.micPath,
      "-vn",
      "-ar", PLAYBACK_SAMPLE_RATE,
      "-ac", "1",
      "-c:a", "pcm_s16le",
      input.outputPath
    ];
  }

  return [
    "-y",
    "-i", input.micPath,
    "-i", input.systemPath,
    "-filter_complex",
    [
      `[0:a]aresample=${PLAYBACK_SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono[mic]`,
      `[1:a]aresample=${PLAYBACK_SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono[sys]`,
      "[mic][sys]amix=inputs=2:duration=longest:dropout_transition=0,volume=2[a]"
    ].join(";"),
    "-map", "[a]",
    "-vn",
    "-ar", PLAYBACK_SAMPLE_RATE,
    "-ac", "1",
    "-c:a", "pcm_s16le",
    input.outputPath
  ];
}

export type TimelineChunk = {
  path: string;
  /** Milliseconds from the start of the recording to the moment this chunk began. */
  offsetMs: number;
};

/**
 * Lays the chunks on the wall-clock timeline instead of butting them together:
 * each rotation loses a few hundred milliseconds while the next recorder
 * starts, and over an hour a plain concat drifts seconds away from the screen
 * video. Chunks never overlap, so an unnormalized amix is a sequential join
 * with the real gaps kept as silence.
 */
export function buildTimelineToAacArgs(chunks: TimelineChunk[], outputPath: string): string[] {
  if (chunks.length === 0) throw new Error("Cannot assemble a meeting recording without audio chunks.");
  const inputs = chunks.flatMap((chunk) => ["-i", chunk.path]);
  const delayed = chunks.map((chunk, i) => {
    const ms = Math.max(0, Math.round(chunk.offsetMs));
    return `[${i}:a]adelay=${ms}:all=1[d${i}]`;
  });
  const labels = chunks.map((_, i) => `[d${i}]`).join("");
  const graph = [...delayed, `${labels}amix=inputs=${chunks.length}:duration=longest:dropout_transition=0:normalize=0[a]`];
  return [
    "-y",
    ...inputs,
    "-filter_complex", graph.join(";"),
    "-map", "[a]",
    "-vn",
    "-c:a", "aac",
    "-b:a", AAC_BITRATE,
    "-movflags", "+faststart",
    outputPath
  ];
}

export function buildMeetingMuxArgs(input: MuxMeetingInput): string[] {
  // -itsoffset delays whichever input started later, so both line up on the
  // wall clock the recorders were started against.
  const offset = Math.abs(input.audioOffsetSec).toFixed(3);
  const videoIn = input.audioOffsetSec < 0 ? ["-itsoffset", offset, "-i", input.videoPath] : ["-i", input.videoPath];
  const audioIn = input.audioOffsetSec > 0 ? ["-itsoffset", offset, "-i", input.audioPath] : ["-i", input.audioPath];
  return [
    "-y",
    ...videoIn,
    ...audioIn,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c", "copy",
    "-movflags", "+faststart",
    input.outputPath
  ];
}

export class MeetingAudioMixer {
  private static cachedBinaryPath: string | null | undefined;

  static getBinaryPath(): string | null {
    if (this.cachedBinaryPath !== undefined) return this.cachedBinaryPath;
    try {
      const mod = localRequire("ffmpeg-static") as unknown;
      const ffmpegPath = typeof mod === "string" ? mod : null;
      if (ffmpegPath && fs.existsSync(ffmpegPath)) {
        this.cachedBinaryPath = ffmpegPath;
        return ffmpegPath;
      }
    } catch {
      // Package not installed.
    }

    for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
      if (fs.existsSync(candidate)) {
        this.cachedBinaryPath = candidate;
        return candidate;
      }
    }

    this.cachedBinaryPath = null;
    return null;
  }

  static mix(input: MixMeetingAudioInput): Promise<void> {
    return this.run(buildMeetingAudioMixArgs(input), "meeting audio mix");
  }

  static run(args: string[], label: string): Promise<void> {
    const bin = this.getBinaryPath();
    if (!bin) return Promise.reject(new Error("ffmpeg binary not found. Install dependencies with `npm install`."));
    return new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderrTail = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg ${label} exited with code ${code}: ${stderrTail}`));
      });
    });
  }
}
