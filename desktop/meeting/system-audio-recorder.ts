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

export class SystemAudioRecorder extends EventEmitter {
  private readonly binPath: string;
  private child: ChildProcess | null = null;
  private outputPath: string | null = null;

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

    let stdout = "";
    let stderrTail = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
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

    child.on("exit", () => {
      this.child = null;
      this.outputPath = null;
    });
    child.stdin?.write(`start ${outputPath}\n`);
    try {
      await ready;
    } catch (err) {
      child.stdin?.write("quit\n");
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

    let stdout = "";
    const stopped = new Promise<string>((resolve) => {
      const onStdout = (chunk: Buffer | string): void => {
        stdout += chunk.toString();
        const line = stdout.split("\n").find((item) => item.startsWith("stopped "));
        if (line) {
          child.stdout?.removeListener("data", onStdout);
          resolve(line.slice("stopped ".length));
        }
      };
      child.stdout?.on("data", onStdout);
      child.once("exit", () => resolve(outputPath));
    });

    child.stdin?.write("stop\n");
    const result = await stopped;
    child.stdin?.write("quit\n");
    this.child = null;
    this.outputPath = null;
    return result;
  }

  kill(): void {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.outputPath = null;
  }
}
