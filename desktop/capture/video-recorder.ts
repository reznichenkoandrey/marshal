// desktop/capture/video-recorder.ts
//
// Spawns the screen-recorder.swift binary, parses line-based events from its
// stdout, and exposes a clean EventEmitter API to the rest of the desktop
// module. One active child at a time — the caller is expected to `stop()`
// before starting another recording.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
// video-recorder.ts compiles to dist/desktop/capture/; the Swift binary sits
// next to it at dist/desktop/capture/screen-recorder (set by postbuild.mjs).
const BINARY_PATH = path.join(desktopDistDir, "screen-recorder");

export interface VideoArea {
  /** Origin x in display-local CSS pixels (pre-Retina). */
  x: number;
  /** Origin y in display-local CSS pixels. */
  y: number;
  width: number;
  height: number;
}

export type VideoEvent = "started" | "paused" | "resumed" | "stopped";

type ChildStreams = ChildProcess & {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
  stderr: NonNullable<ChildProcess["stderr"]>;
};

export class VideoRecorder extends EventEmitter {
  private child: ChildStreams | null = null;
  private recording = false;
  private buffer = "";

  get isRecording(): boolean {
    return this.recording;
  }

  static isAvailable(): boolean {
    return process.platform === "darwin" && fs.existsSync(BINARY_PATH);
  }

  startFullscreen(outPath: string): void {
    this.ensureSpawned();
    this.recording = true;
    this.child!.stdin.write(`start-fullscreen ${outPath}\n`);
  }

  startArea(area: VideoArea, outPath: string): void {
    this.ensureSpawned();
    this.recording = true;
    this.child!.stdin.write(
      `start-area ${area.x} ${area.y} ${area.width} ${area.height} ${outPath}\n`
    );
  }

  pause(): void {
    if (!this.child) return;
    this.child.stdin.write("pause\n");
  }

  resume(): void {
    if (!this.child) return;
    this.child.stdin.write("resume\n");
  }

  /**
   * Stops the current capture and resolves with the written file path.
   * Rejects if the recorder emits an error before we receive `stopped`.
   */
  stop(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error("Recorder is not running"));
        return;
      }

      const onStopped = (outPath: string): void => {
        this.off("error", onError);
        this.recording = false;
        resolve(outPath);
      };
      const onError = (err: Error): void => {
        this.off("stopped", onStopped);
        this.recording = false;
        reject(err);
      };

      this.once("stopped", onStopped);
      this.once("error", onError);
      this.child.stdin.write("stop\n");
    });
  }

  /** Forcefully kill the child process (called on teardown). */
  kill(): void {
    if (!this.child) return;
    try {
      this.child.stdin.write("quit\n");
    } catch {
      // Ignore — we're tearing down.
    }
    this.child.kill("SIGTERM");
    this.child = null;
    this.recording = false;
  }

  private ensureSpawned(): void {
    if (this.child) return;
    if (!VideoRecorder.isAvailable()) {
      throw new Error(
        "screen-recorder binary not found. Run `npm run build` — macOS 12.3+ required."
      );
    }

    const child = spawn(BINARY_PATH, [], {
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildStreams;
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Swift writes human-readable errors here — surface via console, never
      // treat as command responses.
      console.error("[screen-recorder]", chunk.trimEnd());
    });
    child.on("exit", (code) => {
      this.child = null;
      this.recording = false;
      if (code !== 0 && code !== null) {
        this.emit("error", new Error(`screen-recorder exited with code ${code}`));
      }
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trimEnd();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    if (line === "started") this.emit("started");
    else if (line === "paused") this.emit("paused");
    else if (line === "resumed") this.emit("resumed");
    else if (line.startsWith("stopped ")) this.emit("stopped", line.slice("stopped ".length));
    else if (line.startsWith("error ")) this.emit("error", new Error(line.slice("error ".length)));
    else console.warn("[screen-recorder] unexpected output:", line);
  }
}
