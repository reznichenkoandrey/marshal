// desktop/capture/scroll-capture.ts
//
// Orchestrates the two Swift helpers — scroll-capture (frame grabber +
// CGEvent scroll driver) and scroll-stitch (Vision-framework concatenator)
// — into a single async run. Caller picks the rectangle, this module:
//
//   1. spawns scroll-capture with the area + a hard-coded "max 30 scrolls,
//      400 ms settle delay" budget; reads frame paths from its stdout
//   2. waits for `done <N>` or `settled <i>` and collects all frames
//   3. spawns scroll-stitch with `out=...` + the collected frame paths
//   4. resolves with the path to the stitched PNG
//
// Failure modes are reported as plain Error objects so the caller can
// surface them to the user without unwrapping subprocess plumbing.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asarUnpacked } from "../utils/asar-paths.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
// asarUnpacked() — `child_process.spawn` cannot descend into app.asar (#82).
const desktopDistDirOnDisk = asarUnpacked(desktopDistDir);
const scrollCaptureBin = path.join(desktopDistDirOnDisk, "scroll-capture");
const scrollStitchBin = path.join(desktopDistDirOnDisk, "scroll-stitch");

export interface ScrollCaptureOptions {
  /** Capture rectangle in CSS pixels. */
  area: { x: number; y: number; width: number; height: number };
  /** Hard cap on iterations. Default: 30. */
  maxScrolls?: number;
  /** Settle delay between scrolls in ms. Default: 400. */
  delayMs?: number;
  /** Optional path for the final stitched PNG. Defaults to a tmp file. */
  outPath?: string;
}

export interface ScrollCaptureResult {
  outPath: string;
  frameCount: number;
  settledEarly: boolean;
}

export class ScrollCapture {
  static async isAvailable(): Promise<boolean> {
    try {
      await fs.access(scrollCaptureBin);
      await fs.access(scrollStitchBin);
      return true;
    } catch {
      return false;
    }
  }

  async run(opts: ScrollCaptureOptions): Promise<ScrollCaptureResult> {
    if (!(await ScrollCapture.isAvailable())) {
      throw new Error(
        "Scrolling capture is unavailable — Swift helpers were not compiled. " +
          "Re-run `npm run build` on macOS to regenerate them."
      );
    }

    const maxScrolls = opts.maxScrolls ?? 30;
    const delayMs = opts.delayMs ?? 400;
    const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), "marshal-scroll-"));
    const outPath =
      opts.outPath ??
      path.join(framesDir, `scroll-${Date.now()}.png`);

    // Step 1 — capture frames.
    const { frames, settledEarly } = await this.runFrameCapture({
      area: opts.area,
      framesDir,
      maxScrolls,
      delayMs
    });

    if (frames.length === 0) {
      await fs.rm(framesDir, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("scroll-capture produced no frames");
    }

    // Step 2 — stitch.
    try {
      await this.runStitch(frames, outPath);
    } catch (err) {
      // Keep the frames around for debugging if stitching fails — saves the
      // user a re-capture and gives us something to file with the bug.
      throw new Error(
        `Stitching failed (${(err as Error).message}). ` +
          `Raw frames left in ${framesDir} for inspection.`
      );
    }

    // Best-effort cleanup of the individual frames; stitched PNG already
    // copied out by scroll-stitch.
    if (!outPath.startsWith(framesDir)) {
      await fs.rm(framesDir, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      outPath,
      frameCount: frames.length,
      settledEarly
    };
  }

  private runFrameCapture(input: {
    area: ScrollCaptureOptions["area"];
    framesDir: string;
    maxScrolls: number;
    delayMs: number;
  }): Promise<{ frames: string[]; settledEarly: boolean }> {
    return new Promise((resolve, reject) => {
      const args = [
        String(input.area.x),
        String(input.area.y),
        String(input.area.width),
        String(input.area.height),
        input.framesDir,
        String(input.maxScrolls),
        String(input.delayMs)
      ];
      const child = spawn(scrollCaptureBin, args, { stdio: ["ignore", "pipe", "pipe"] });

      const frames: string[] = [];
      let settledEarly = false;
      let stderr = "";
      let stdoutBuf = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        let nlIndex: number;
        while ((nlIndex = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, nlIndex).trim();
          stdoutBuf = stdoutBuf.slice(nlIndex + 1);
          if (line.startsWith("frame ")) {
            frames.push(line.slice("frame ".length));
          } else if (line.startsWith("settled ")) {
            settledEarly = true;
          }
          // `done <N>` arrives just before the process exits; we don't need to
          // parse it — the exit handler resolves regardless.
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => reject(err));
      child.on("exit", (code) => {
        if (code === 0) {
          resolve({ frames, settledEarly });
        } else {
          reject(new Error(`scroll-capture exited ${code}: ${stderr.trim() || "no stderr"}`));
        }
      });
    });
  }

  private runStitch(frames: string[], outPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [`out=${outPath}`, ...frames];
      const child = spawn(scrollStitchBin, args, { stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => reject(err));
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`scroll-stitch exited ${code}: ${stderr.trim() || "no stderr"}`));
        }
      });
    });
  }
}
