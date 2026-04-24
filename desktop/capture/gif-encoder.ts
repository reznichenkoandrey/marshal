// desktop/capture/gif-encoder.ts
//
// Two-pass palettegen/paletteuse conversion from .mov/.mp4 to .gif, driven
// by the `ffmpeg-static` binary so users don't need ffmpeg on PATH.
//
// Shape:
//   GifEncoder.convert(opts, onProgress) → Promise<void>
//
// Pass 1 generates a 256-colour palette tuned to the source video, pass 2
// applies it with Lanczos scaling and Bayer dithering. This is the standard
// recipe for small-and-pretty GIFs and matches CleanShot's defaults.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

const localRequire = createRequire(import.meta.url);

export interface GifOptions {
  inputPath: string;
  outputPath: string;
  /** Output framerate. Typical: 10, 15, 24. */
  fps: number;
  /** Output width in pixels (height derived). 0 = keep source width. */
  width: number;
  /** true → infinite loop (ffmpeg -loop 0); false → play once (-1). */
  loop: boolean;
}

/** Fractional progress in [0, 1]. */
export type ProgressCallback = (progress: number) => void;

export class GifEncoder {
  private static cachedBinaryPath: string | null | undefined;

  /** Return the path to a usable ffmpeg binary, or null. */
  static getBinaryPath(): string | null {
    if (this.cachedBinaryPath !== undefined) return this.cachedBinaryPath;

    const fromBundle = this.resolveBundled();
    if (fromBundle) {
      this.cachedBinaryPath = fromBundle;
      return fromBundle;
    }

    // Fall back to common system paths. Users with `brew install ffmpeg`
    // typically have one of these.
    for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
      if (fs.existsSync(candidate)) {
        this.cachedBinaryPath = candidate;
        return candidate;
      }
    }

    this.cachedBinaryPath = null;
    return null;
  }

  static isAvailable(): boolean {
    return this.getBinaryPath() !== null;
  }

  static async convert(opts: GifOptions, onProgress?: ProgressCallback): Promise<void> {
    const bin = this.getBinaryPath();
    if (!bin) {
      throw new Error("ffmpeg binary not found. Install it or run `npm install`.");
    }

    const palettePath = `${opts.outputPath}.palette.png`;
    const vfBase = opts.width > 0
      ? `fps=${opts.fps},scale=${opts.width}:-1:flags=lanczos`
      : `fps=${opts.fps}`;

    const totalSec = await this.probeDuration(bin, opts.inputPath);

    try {
      // Pass 1 — palette generation. Diff-mode keeps the palette tight when
      // most frames are static (typical for app demos).
      await this.runFfmpeg(bin, [
        "-y", "-i", opts.inputPath,
        "-vf", `${vfBase},palettegen=stats_mode=diff`,
        palettePath
      ], (sec) => onProgress?.(Math.min(0.4, (sec / Math.max(totalSec, 0.1)) * 0.4)));

      // Pass 2 — apply the palette to the video stream.
      const loopArg = opts.loop ? "0" : "-1";
      await this.runFfmpeg(bin, [
        "-y", "-i", opts.inputPath, "-i", palettePath,
        "-lavfi",
          `${vfBase} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
        "-loop", loopArg,
        opts.outputPath
      ], (sec) => onProgress?.(0.4 + Math.min(0.6, (sec / Math.max(totalSec, 0.1)) * 0.6)));

      onProgress?.(1);
    } finally {
      try { fs.unlinkSync(palettePath); } catch { /* palette is a scratch file */ }
    }
  }

  private static resolveBundled(): string | null {
    try {
      const mod = localRequire("ffmpeg-static") as unknown;
      const p = typeof mod === "string" ? mod : null;
      if (p && fs.existsSync(p)) return p;
    } catch {
      // Package not installed.
    }
    return null;
  }

  /** Parse `Duration: HH:MM:SS.fff` from ffmpeg's probe output. */
  private static probeDuration(bin: string, filePath: string): Promise<number> {
    return new Promise((resolve) => {
      let stderr = "";
      const p = spawn(bin, ["-i", filePath]);
      p.stderr.setEncoding("utf8");
      p.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      p.on("close", () => {
        const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)(?:\.(\d+))?/u);
        if (!match) {
          // No duration header — conservative default so progress doesn't
          // flatline at 0.
          resolve(10);
          return;
        }
        const [, h, m, s, frac = "0"] = match;
        const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac}`);
        resolve(seconds);
      });
    });
  }

  private static runFfmpeg(
    bin: string,
    args: string[],
    onSec: (sec: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn(bin, args);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      let stderrTail = "";
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk: string) => {
        // Keep only the tail so very chatty failures don't blow memory.
        stderrTail = (stderrTail + chunk).slice(-2000);
        const match = chunk.match(/time=(\d+):(\d+):(\d+)(?:\.(\d+))?/u);
        if (match) {
          const [, h, m, s, frac = "0"] = match;
          const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac}`);
          onSec(seconds);
        }
      });

      proc.on("error", (err) => reject(err));
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}\n${stderrTail}`));
      });
    });
  }
}
