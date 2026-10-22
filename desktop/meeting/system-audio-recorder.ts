import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asarUnpacked } from "../utils/asar-paths.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const DEFAULT_BINARY_PATH = path.join(
  asarUnpacked(path.resolve(desktopDistDir, "..", "capture")),
  "system-audio-recorder"
);

// Generous for Gatekeeper's first-exec check after an install (#181); a start
// that never answers must not hold the whole recording hostage.
const START_TIMEOUT_MS = 45_000;

export type SystemAudioRecorderEvents = {
  /** The helper lost its stream or died while recording; its file is suspect. */
  failed: [string];
};

export class SystemAudioRecorder extends EventEmitter<SystemAudioRecorderEvents> {
  private readonly binPath: string;
  private child: ChildProcess | null = null;
  private outputPath: string | null = null;
  private stopRequested = false;

  constructor(binPath = process.env.MARSHAL_SYSTEM_AUDIO_RECORDER_BIN ?? DEFAULT_BINARY_PATH) {
    super();
    this.binPath = binPath;
  }

  isAvailable(): boolean {
    return process.platform === "darwin" && fs.existsSync(this.binPath);
  }

  isRecording(): boolean {
    return this.child !== null;
  }

  async start(outputPath: string): Promise<void> {
    if (this.child) throw new Error("System audio recording is already active.");
    if (!this.isAvailable()) throw new Error(`System audio recorder missing at ${this.binPath}.`);

    const child = spawn(this.binPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.outputPath = outputPath;
    this.stopRequested = false;

    let stdout = "";
    let stderrTail = "";
    let started = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // A helper that died closes its end of the pipe before Node sees its exit;
    // a command written in between fails with EPIPE, and without a listener
    // that is an uncaught exception in Electron's main process (#260). The
    // exit itself is what reports the dead helper.
    child.stdin?.on("error", (err: Error) => {
      stderrTail = (stderrTail + ` stdin: ${err.message}`).slice(-2000);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    const ready = new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        child.stdout?.removeListener("data", onStdout);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
      };
      const onStdout = (chunk: string): void => {
        stdout += chunk;
        for (const line of stdout.split("\n")) {
          if (line === "started") {
            cleanup();
            resolve();
            return;
          }
          if (line.startsWith("error ")) {
            cleanup();
            reject(new Error(line.slice("error ".length)));
            return;
          }
        }
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onExit = (code: number | null): void => {
        cleanup();
        reject(new Error(`System audio recorder exited before start (${code ?? "signal"}): ${stderrTail}`));
      };
      child.stdout?.on("data", onStdout);
      child.once("error", onError);
      child.once("exit", onExit);
    });

    // A helper that was told to quit exits after the next one has already
    // been spawned; clearing unconditionally would orphan the new helper and
    // its file would never be finalized (#250).
    child.on("exit", (code) => {
      if (this.child !== child) return;
      const unexpected = started && !this.stopRequested;
      this.child = null;
      this.outputPath = null;
      if (unexpected) this.emit("failed", `system audio helper exited while recording (${code ?? "signal"}): ${stderrTail}`.trim());
    });
    child.stdin?.write(`start ${outputPath}\n`);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`System audio did not start within ${START_TIMEOUT_MS / 1000} s: ${stderrTail}`)),
        START_TIMEOUT_MS
      );
    });
    try {
      await Promise.race([ready, timeout]);
      clearTimeout(timer);
      started = true;
      // ScreenCaptureKit reports a stream that died mid-recording as an
      // `error` line; without this the call kept "recording" silence.
      let tail = "";
      child.stdout?.on("data", (chunk: string) => {
        tail += chunk;
        const lines = tail.split("\n");
        tail = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("error ") && this.child === child && !this.stopRequested) {
            this.emit("failed", line.slice("error ".length));
          }
        }
      });
    } catch (err) {
      clearTimeout(timer);
      send(child, "quit");
      child.kill("SIGTERM");
      this.child = null;
      this.outputPath = null;
      throw err;
    }
  }

  async stop(): Promise<string | null> {
    const child = this.child;
    const outputPath = this.outputPath;
    if (!child || !outputPath) return null;

    this.stopRequested = true;
    let stdout = "";
    const stopped = new Promise<string>((resolve, reject) => {
      const onStdout = (chunk: Buffer | string): void => {
        stdout += chunk.toString();
        const lines = stdout.split("\n");
        const done = lines.find((item) => item.startsWith("stopped "));
        // A failed stop answers `error …` and never `stopped …`; waiting only
        // for the latter would hang the whole meeting stop.
        const failed = lines.find((item) => item.startsWith("error "));
        if (done || failed) child.stdout?.removeListener("data", onStdout);
        if (done) resolve(done.slice("stopped ".length));
        else if (failed) reject(new Error(failed.slice("error ".length)));
      };
      child.stdout?.on("data", onStdout);
      child.once("exit", () => resolve(outputPath));
    });

    // A helper that can no longer read commands still finalizes its file on
    // SIGTERM; without one, nothing would ever end this wait.
    if (!send(child, "stop")) child.kill("SIGTERM");
    try {
      return await stopped;
    } finally {
      send(child, "quit");
      this.child = null;
      this.outputPath = null;
    }
  }

  kill(): void {
    this.stopRequested = true;
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.outputPath = null;
  }
}

/** Writes one command line; false when the helper can no longer receive it. */
function send(child: ChildProcess, command: string): boolean {
  if (child.exitCode !== null || child.signalCode !== null || !child.stdin?.writable) return false;
  child.stdin.write(`${command}\n`);
  return true;
}
