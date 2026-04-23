// desktop/dictation/dictation-service.ts
// Push-to-talk dictation orchestrator. Holds a hotkey → records audio →
// transcribes via whisper.cpp (or Groq) → writes transcript to clipboard.
//
// Lifecycle / guarantees:
// - Single-record guard: a new hotkey-down while another transcription is in
//   flight is ignored (silent) rather than queued.
// - The WAV temp file is always deleted, even on transcribe failure.
// - Errors surface via the `error` event so the tray / OS notification layer
//   can react.

import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { clipboard } from "electron";

import { PushToTalkHotkey } from "./hotkey-manager.ts";
import {
  createWhisperBackend,
  resolveBackendName,
  type WhisperBackend
} from "./whisper-backend.ts";

const DEFAULT_HOTKEY = "RightCmd";
const currentFilePath = fileURLToPath(import.meta.url);
const distDictationDir = path.dirname(currentFilePath);
const DEFAULT_RECORDER_BIN = path.join(distDictationDir, "audio-recorder");

export type DictationEvents = {
  "recording-start": [];
  "recording-stop": [];
  transcribed: [{ text: string; language?: string }];
  error: [Error];
};

export class DictationService extends EventEmitter {
  private readonly hotkey: PushToTalkHotkey;
  private readonly backend: WhisperBackend;
  private readonly recorderBin: string;
  private recorderProcess: ChildProcess | null = null;
  private currentWavPath: string | null = null;
  private isStopping = false;
  private isTranscribing = false;

  constructor() {
    super();
    const hotkeyString = process.env.MARSHAL_DICTATION_HOTKEY ?? DEFAULT_HOTKEY;
    this.hotkey = new PushToTalkHotkey(hotkeyString);
    this.backend = createWhisperBackend(resolveBackendName(process.env.MARSHAL_DICTATION_BACKEND));
    this.recorderBin = process.env.MARSHAL_DICTATION_RECORDER_BIN ?? DEFAULT_RECORDER_BIN;

    this.hotkey.on("hold-start", () => this.handleHoldStart());
    this.hotkey.on("hold-end", () => this.handleHoldEnd());
  }

  async start(): Promise<void> {
    try {
      await fs.access(this.recorderBin);
    } catch {
      this.emit(
        "error",
        new Error(
          `Dictation recorder binary missing at ${this.recorderBin}. Run \`npm run build\` to compile it.`
        )
      );
      return;
    }
    this.hotkey.start();
  }

  stop(): void {
    this.hotkey.stop();
    if (this.recorderProcess) {
      this.recorderProcess.kill("SIGTERM");
      this.recorderProcess = null;
    }
    if (this.currentWavPath) {
      void fs.unlink(this.currentWavPath).catch(() => undefined);
      this.currentWavPath = null;
    }
  }

  private handleHoldStart(): void {
    if (this.recorderProcess || this.isTranscribing) return;

    const wavPath = path.join(os.tmpdir(), `marshal-dict-${randomUUID()}.wav`);
    this.currentWavPath = wavPath;

    const child = spawn(this.recorderBin, [wavPath], { stdio: ["ignore", "pipe", "pipe"] });
    this.recorderProcess = child;
    this.isStopping = false;

    child.stdout?.once("data", () => {
      // "ready" — engine is up. Safe to treat as recording.
      this.emit("recording-start");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      console.warn("[dictation] recorder stderr:", chunk.toString("utf8").trim());
    });
    child.on("error", (err) => {
      this.recorderProcess = null;
      this.currentWavPath = null;
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
    child.on("exit", (code) => {
      this.recorderProcess = null;
      if (!this.isStopping) {
        // Recorder died unexpectedly — clean up without transcribing (partial
        // WAV files usually have no valid header).
        const stalePath = this.currentWavPath;
        this.currentWavPath = null;
        if (stalePath) void fs.unlink(stalePath).catch(() => undefined);
        if (code !== 0 && code !== null) {
          this.emit("error", new Error(`Audio recorder exited unexpectedly (${code})`));
        }
      }
    });
  }

  private handleHoldEnd(): void {
    const child = this.recorderProcess;
    const wavPath = this.currentWavPath;
    if (!child || !wavPath) return;

    this.isStopping = true;
    this.emit("recording-stop");
    // Kick off SIGTERM → recorder flushes WAV and exits. Then we transcribe.
    void this.finishRecording(child, wavPath).catch((err: unknown) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  private async finishRecording(child: ChildProcess, wavPath: string): Promise<void> {
    this.isTranscribing = true;
    try {
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
      this.currentWavPath = null;

      const stat = await fs.stat(wavPath).catch(() => null);
      // WAV header is 44 bytes; anything smaller means we captured nothing.
      if (!stat || stat.size < 1024) {
        return;
      }

      const result = await this.backend.transcribe(wavPath);
      if (result.text.length > 0) {
        clipboard.writeText(result.text);
        this.emit("transcribed", result);
      }
    } finally {
      this.isTranscribing = false;
      await fs.unlink(wavPath).catch(() => undefined);
    }
  }
}
