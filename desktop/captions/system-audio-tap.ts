// desktop/captions/system-audio-tap.ts
//
// Node side of the `system-audio-tap` Swift helper: spawns it, waits for the
// `ready` handshake on stderr, and re-emits stdout as PCM chunks. See the
// Swift file for the wire protocol.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asarUnpacked } from "../utils/asar-paths.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const distCaptionsDir = asarUnpacked(path.dirname(currentFilePath));
const DEFAULT_BIN = path.join(distCaptionsDir, "system-audio-tap");
const READY_TIMEOUT_MS = 8_000;

export type SystemAudioTapEvents = {
  pcm: [Buffer];
  error: [Error];
  exit: [number | null];
  /** Microphone mixing state reported by the helper (#191). */
  mic: [{ on: boolean; reason?: string }];
};

export interface SystemAudioTapOptions {
  /** Mix the microphone into the stream (macOS 15+). */
  microphone?: boolean;
  /** Core Audio unique ID of the microphone; empty = default input. */
  microphoneDevice?: string;
}

export class SystemAudioTap extends EventEmitter<SystemAudioTapEvents> {
  private readonly binPath: string;
  private child: ChildProcess | null = null;

  constructor(binPath = process.env.MARSHAL_SYSTEM_AUDIO_TAP_BIN ?? DEFAULT_BIN) {
    super();
    this.binPath = binPath;
  }

  isAvailable(): boolean {
    return process.platform === "darwin" && fs.existsSync(this.binPath);
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  async start(options: SystemAudioTapOptions = {}): Promise<void> {
    if (this.child) throw new Error("System audio tap is already running.");
    if (!this.isAvailable()) {
      throw new Error(`system-audio-tap helper missing at ${this.binPath}. Run \`npm run build\`.`);
    }

    const args: string[] = [];
    if (options.microphone) {
      args.push("--mic");
      if (options.microphoneDevice) args.push("--mic-device", options.microphoneDevice);
    }
    const child = spawn(this.binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;

    let stderrBuffer = "";
    let ready = false;
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("system-audio-tap did not become ready — is Screen Recording granted?"));
      }, READY_TIMEOUT_MS);
      const settle = (err?: Error): void => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrBuffer += chunk;
        let newline: number;
        while ((newline = stderrBuffer.indexOf("\n")) >= 0) {
          const line = stderrBuffer.slice(0, newline).trim();
          stderrBuffer = stderrBuffer.slice(newline + 1);
          if (line === "ready") {
            ready = true;
            settle();
          } else if (line.startsWith("error ")) {
            const error = new Error(line.slice("error ".length));
            if (!ready) settle(error);
            else this.emit("error", error);
          } else if (line === "mic on") {
            this.emit("mic", { on: true });
          } else if (line.startsWith("mic unavailable")) {
            this.emit("mic", { on: false, reason: line.slice("mic unavailable".length).trim() });
          } else if (line.length > 0) {
            console.warn("[captions] audio tap stderr:", line);
          }
        }
      });
      child.once("error", (err) => settle(err));
      child.once("exit", (code) => {
        if (!ready) settle(new Error(`system-audio-tap exited before ready (${code ?? "signal"})`));
      });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      this.emit("pcm", chunk);
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      this.emit("exit", code);
    });

    try {
      await readyPromise;
    } catch (err) {
      child.kill("SIGKILL");
      this.child = null;
      throw err;
    }
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.kill("SIGTERM");
    // The helper stops the SCStream on SIGTERM and exits by itself; if it
    // hangs on a wedged stream, do not let it outlive the session.
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000);
    child.once("exit", () => clearTimeout(killTimer));
  }
}
