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
import { asarUnpacked } from "../utils/asar-paths.ts";
import { probeFocusedElement, sendPasteKeystroke } from "./focus-paste.ts";
import {
  createWhisperBackend,
  resolveBackendName,
  resolveDictationPrompt,
  type WhisperBackend
} from "./whisper-backend.ts";

const DEFAULT_HOTKEY = "RightCmd";
// Hard safety-net: if the keyup event never arrives (known uiohook quirks on
// macOS for modifier-only keys, #49) we auto-stop after this many ms.
const MAX_RECORDING_MS = 60_000;
const currentFilePath = fileURLToPath(import.meta.url);
const distDictationDir = path.dirname(currentFilePath);
// asarUnpacked() — `child_process.spawn` cannot descend into app.asar (#82).
const DEFAULT_RECORDER_BIN = path.join(asarUnpacked(distDictationDir), "audio-recorder");

function debug(...args: unknown[]): void {
  if (process.env.MARSHAL_DICTATION_DEBUG === "1") {
    console.log("[dictation]", ...args);
  }
}

export type DictationEvents = {
  "recording-start": [];
  "recording-stop": [];
  transcribed: [{ text: string; language?: string }];
  error: [Error];
};

function resolveLanguage(raw: string | undefined): string | undefined {
  const value = (raw ?? "auto").toLowerCase().trim();
  if (!value || value === "auto") return undefined;
  // Whisper language codes are 2-letter ISO 639-1. Keep the first two chars
  // so both "uk" and "uk-UA" work.
  return value.slice(0, 2);
}

export class DictationService extends EventEmitter {
  private readonly hotkey: PushToTalkHotkey;
  private readonly backend: WhisperBackend;
  private readonly recorderBin: string;
  private readonly language: string | undefined;
  private readonly prompt: string;
  private recorderProcess: ChildProcess | null = null;
  private currentWavPath: string | null = null;
  private isStopping = false;
  private isTranscribing = false;
  private safetyTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    const hotkeyString = process.env.MARSHAL_DICTATION_HOTKEY ?? DEFAULT_HOTKEY;
    this.hotkey = new PushToTalkHotkey(hotkeyString);
    this.backend = createWhisperBackend(resolveBackendName(process.env.MARSHAL_DICTATION_BACKEND));
    this.recorderBin = process.env.MARSHAL_DICTATION_RECORDER_BIN ?? DEFAULT_RECORDER_BIN;
    this.language = resolveLanguage(process.env.MARSHAL_DICTATION_LANGUAGE);
    this.prompt = resolveDictationPrompt(process.env.MARSHAL_DICTATION_PROMPT);

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
    debug("hold-start");
    if (this.recorderProcess || this.isTranscribing) {
      debug("  skip — already recording or transcribing");
      return;
    }

    const wavPath = path.join(os.tmpdir(), `marshal-dict-${randomUUID()}.wav`);
    this.currentWavPath = wavPath;
    debug("  spawn recorder:", this.recorderBin, "→", wavPath);

    const child = spawn(this.recorderBin, [wavPath], { stdio: ["ignore", "pipe", "pipe"] });
    this.recorderProcess = child;
    this.isStopping = false;

    // Safety net — force stop after MAX_RECORDING_MS if the user's keyup
    // event is ever lost by the OS (#49).
    this.safetyTimer = setTimeout(() => {
      debug("safety timeout — forcing hold-end after", MAX_RECORDING_MS, "ms");
      this.hotkey.forceEnd();
    }, MAX_RECORDING_MS);

    child.stdout?.once("data", () => {
      // "ready" — engine is up. Safe to treat as recording.
      debug("  recorder ready");
      this.emit("recording-start");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      console.warn("[dictation] recorder stderr:", chunk.toString("utf8").trim());
    });
    child.on("error", (err) => {
      this.recorderProcess = null;
      this.currentWavPath = null;
      this.clearSafetyTimer();
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
    child.on("exit", (code) => {
      debug("  recorder exited, code=", code, "isStopping=", this.isStopping);
      this.recorderProcess = null;
      if (!this.isStopping) {
        this.clearSafetyTimer();
        // Recorder died unexpectedly — clean up without transcribing (partial
        // WAV files usually have no valid header).
        const stalePath = this.currentWavPath;
        this.currentWavPath = null;
        if (stalePath) void fs.unlink(stalePath).catch(() => undefined);
        if (code !== 0 && code !== null) {
          this.emit(
            "error",
            new Error(
              `Audio recorder exited unexpectedly (${code}). ` +
                `If this is the first run, grant Marshal/Electron microphone access ` +
                `in System Settings → Privacy & Security → Microphone and try again.`
            )
          );
        }
      }
    });
  }

  private handleHoldEnd(): void {
    debug("hold-end");
    this.clearSafetyTimer();
    const child = this.recorderProcess;
    const wavPath = this.currentWavPath;
    if (!child || !wavPath) {
      debug("  skip — no active recorder");
      return;
    }

    this.isStopping = true;
    this.emit("recording-stop");
    void this.finishRecording(child, wavPath).catch((err: unknown) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  private async maybeAutoPaste(): Promise<void> {
    const focus = await probeFocusedElement();
    if (!focus.isTextInput) {
      debug("no editable focus — clipboard only (role=", focus.role || "?", ")");
      return;
    }
    debug("focused element accepts text — auto-pasting (role=", focus.role, ")");
    try {
      await sendPasteKeystroke();
    } catch (err) {
      // Don't surface as a fatal error — clipboard fallback is still usable.
      debug("auto-paste failed, leaving clipboard for manual paste:", err);
    }
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
      debug("WAV size:", stat?.size ?? "missing");
      // WAV header is 44 bytes; anything smaller means we captured nothing.
      if (!stat || stat.size < 1024) {
        this.emit(
          "error",
          new Error(
            `Audio file is empty (${stat?.size ?? 0} bytes). Likely cause: ` +
              `microphone access is denied. Open System Settings → Privacy & ` +
              `Security → Microphone and enable Electron/Marshal.`
          )
        );
        return;
      }

      debug("transcribing… lang=", this.language ?? "auto");
      const result = await this.backend.transcribe(wavPath, {
        language: this.language,
        prompt: this.prompt
      });
      debug("transcribed:", result.text.length, "chars, lang=", result.language);
      if (result.text.length > 0) {
        clipboard.writeText(result.text);
        // Focus-aware paste (#90): if the user's cursor sits inside a text
        // input, slip the transcript in via Cmd+V; otherwise leave it on the
        // clipboard so they can place it deliberately. Both probe and paste
        // are best-effort — failures swallow back to clipboard-only.
        await this.maybeAutoPaste();
        this.emit("transcribed", result);
      } else {
        this.emit(
          "error",
          new Error(
            "Transcription returned an empty string. " +
              "The audio probably had no recognizable speech."
          )
        );
      }
    } finally {
      this.isTranscribing = false;
      await fs.unlink(wavPath).catch(() => undefined);
    }
  }
}
