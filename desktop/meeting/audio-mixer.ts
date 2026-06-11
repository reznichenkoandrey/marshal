import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

const localRequire = createRequire(import.meta.url);

export type MixMeetingAudioInput = {
  micPath: string;
  systemPath?: string;
  outputPath: string;
};

export function buildMeetingAudioMixArgs(input: MixMeetingAudioInput): string[] {
  if (!input.systemPath) {
    return [
      "-y",
      "-i", input.micPath,
      "-vn",
      "-ar", "16000",
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
      "[0:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[mic]",
      "[1:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[sys]",
      "[mic][sys]amix=inputs=2:duration=longest:dropout_transition=0,volume=2[a]"
    ].join(";"),
    "-map", "[a]",
    "-vn",
    "-ar", "16000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
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

  static async mix(input: MixMeetingAudioInput): Promise<void> {
    const bin = this.getBinaryPath();
    if (!bin) throw new Error("ffmpeg binary not found. Install dependencies with `npm install`.");
    const args = buildMeetingAudioMixArgs(input);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderrTail = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg meeting audio mix exited with code ${code}: ${stderrTail}`));
      });
    });
  }
}
