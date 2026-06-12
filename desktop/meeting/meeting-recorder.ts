import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { asarUnpacked } from "../utils/asar-paths.ts";
import {
  createWhisperBackend,
  resolveBackendName,
  resolveDictationLanguage,
  resolveDictationPrompt,
  type TranscribeResult,
  type WhisperBackend
} from "../dictation/whisper-backend.ts";
import { MeetingAudioMixer } from "./audio-mixer.ts";
import { SystemAudioRecorder } from "./system-audio-recorder.ts";
import { stitchWavPcm16Mono16k } from "./wav-stitcher.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const DEFAULT_RECORDER_BIN = path.join(
  asarUnpacked(path.resolve(desktopDistDir, "..", "dictation")),
  "audio-recorder"
);
const DEFAULT_CHUNK_MS = 5 * 60 * 1000;

export type MeetingRecordingEvents = {
  "recording-start": [];
  "recording-stop": [{ session: MeetingSessionSummary }];
  transcribed: [{ session: MeetingSessionSummary; result: TranscribeResult }];
  error: [Error];
};

export type MeetingChunkManifest = {
  index: number;
  path: string;
  micPath: string;
  systemPath?: string;
  startedAt: string;
  stoppedAt?: string;
  bytes?: number;
};

export type MeetingManifest = {
  id: string;
  state: "recording" | "stitching" | "transcribing" | "done" | "error";
  source: "microphone" | "microphone+system";
  startedAt: string;
  stoppedAt?: string;
  folder: string;
  chunks: MeetingChunkManifest[];
  warnings?: string[];
  audioPath?: string;
  transcriptPath?: string;
  transcriptText?: string;
  language?: string;
  error?: string;
};

export type MeetingSessionSummary = {
  id: string;
  folder: string;
  audioPath: string;
  transcriptPath?: string;
};

type ActiveChunk = {
  child: ChildProcess;
  path: string;
  micPath: string;
  systemPath: string | null;
  systemRecorder: SystemAudioRecorder | null;
  index: number;
  startedAt: string;
};

type MeetingRecorderOptions = {
  userDataDir: string;
  recorderBin?: string;
  backend?: WhisperBackend;
  chunkMs?: number;
};

export class MeetingRecorder extends EventEmitter {
  private readonly userDataDir: string;
  private readonly recorderBin: string;
  private readonly backend: WhisperBackend;
  private readonly chunkMs: number;
  private readonly systemAudioRecorder: SystemAudioRecorder | null;
  private manifest: MeetingManifest | null = null;
  private currentChunk: ActiveChunk | null = null;
  private chunkTimer: NodeJS.Timeout | null = null;
  private rotationPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(options: MeetingRecorderOptions) {
    super();
    this.userDataDir = options.userDataDir;
    this.recorderBin = options.recorderBin ?? process.env.MARSHAL_DICTATION_RECORDER_BIN ?? DEFAULT_RECORDER_BIN;
    this.backend = options.backend ?? createWhisperBackend(resolveBackendName(process.env.MARSHAL_DICTATION_BACKEND));
    const systemRecorder = new SystemAudioRecorder();
    this.systemAudioRecorder = systemRecorder.isAvailable() ? systemRecorder : null;
    const configuredChunkMs = Number.parseInt(process.env.MARSHAL_MEETING_CHUNK_MS ?? "", 10);
    this.chunkMs = options.chunkMs ?? (Number.isFinite(configuredChunkMs) && configuredChunkMs > 0
      ? configuredChunkMs
      : DEFAULT_CHUNK_MS);
  }

  isRecording(): boolean {
    return this.manifest?.state === "recording" || this.manifest?.state === "stitching";
  }

  async start(): Promise<MeetingManifest> {
    if (this.isRecording() || this.currentChunk) {
      throw new Error("Meeting recording is already active.");
    }
    if (!existsSync(this.recorderBin)) {
      throw new Error(`Meeting recorder binary missing at ${this.recorderBin}. Run \`npm run build\`.`);
    }

    try {
      this.stopping = false;
      const now = new Date();
      const id = `meeting-${formatStamp(now)}-${randomUUID().slice(0, 8)}`;
      const folder = path.join(this.userDataDir, "meetings", id);
      await fs.mkdir(folder, { recursive: true });
      this.manifest = {
        id,
        state: "recording",
        source: this.systemAudioRecorder ? "microphone+system" : "microphone",
        startedAt: now.toISOString(),
        folder,
        chunks: []
      };
      await this.writeManifest();
      await this.startChunk();
      this.emit("recording-start");
      return this.manifest;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.clearChunkTimer();
      this.killCurrentChunk();
      if (this.manifest) {
        this.manifest.state = "error";
        this.manifest.error = error.message;
        await this.writeManifest().catch(() => undefined);
      }
      this.manifest = null;
      this.stopping = false;
      throw error;
    }
  }

  async stop(): Promise<MeetingSessionSummary | null> {
    if (!this.manifest) return null;
    let summary: MeetingSessionSummary | null = null;
    try {
      this.stopping = true;
      this.clearChunkTimer();
      if (this.rotationPromise) await this.rotationPromise;
      if (this.currentChunk) await this.stopCurrentChunk();

      const manifest = this.manifest;
      manifest.state = "stitching";
      manifest.stoppedAt = new Date().toISOString();
      await this.writeManifest();

      const audioPath = path.join(manifest.folder, "meeting.wav");
      await stitchWavPcm16Mono16k(manifest.chunks.map((chunk) => chunk.path), audioPath);
      manifest.audioPath = audioPath;
      manifest.state = "transcribing";
      await this.writeManifest();

      summary = { id: manifest.id, folder: manifest.folder, audioPath };
      this.emit("recording-stop", { session: summary });

      const result = await this.backend.transcribe(audioPath, {
        language: resolveDictationLanguage(process.env.MARSHAL_DICTATION_LANGUAGE),
        prompt: resolveDictationPrompt(process.env.MARSHAL_MEETING_PROMPT ?? process.env.MARSHAL_DICTATION_PROMPT)
      });
      const transcriptPath = path.join(manifest.folder, "transcript.txt");
      await fs.writeFile(transcriptPath, result.text, "utf8");
      manifest.state = "done";
      manifest.transcriptPath = transcriptPath;
      manifest.transcriptText = result.text;
      manifest.language = result.language;
      await this.writeManifest();
      summary.transcriptPath = transcriptPath;
      this.emit("transcribed", { session: summary, result });
      return summary;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.manifest) {
        this.manifest.state = "error";
        this.manifest.error = error.message;
        await this.writeManifest().catch(() => undefined);
      }
      this.emit("error", error);
      return summary;
    } finally {
      this.manifest = null;
      this.stopping = false;
    }
  }

  kill(): void {
    this.stopping = true;
    this.clearChunkTimer();
    this.killCurrentChunk();
    this.manifest = null;
  }

  private killCurrentChunk(): void {
    if (this.currentChunk) {
      this.currentChunk.systemRecorder?.kill();
      this.currentChunk.child.kill("SIGTERM");
      this.currentChunk = null;
    }
  }

  private async startChunk(): Promise<void> {
    if (!this.manifest || this.stopping) return;
    const index = this.manifest.chunks.length;
    const chunkName = `chunk-${String(index + 1).padStart(4, "0")}`;
    const chunkPath = path.join(this.manifest.folder, `${chunkName}.wav`);
    const micPath = path.join(this.manifest.folder, `${chunkName}-mic.wav`);
    const systemPath = path.join(this.manifest.folder, `${chunkName}-system.m4a`);
    const micUid = (process.env.MARSHAL_DICTATION_MIC ?? "").trim();
    const args = micUid ? [micPath, "--device", micUid] : [micPath];
    const child = spawn(this.recorderBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const startedAt = new Date().toISOString();
    let systemRecorder: SystemAudioRecorder | null = null;
    let activeSystemPath: string | null = null;
    if (this.systemAudioRecorder) {
      try {
        await this.systemAudioRecorder.start(systemPath);
        systemRecorder = this.systemAudioRecorder;
        activeSystemPath = systemPath;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.manifest.warnings ??= [];
        this.manifest.warnings.push(`System audio unavailable for ${chunkName}: ${message}`);
      }
    } else {
      this.manifest.warnings ??= [];
      if (!this.manifest.warnings.includes("System audio recorder unavailable; using microphone-only meeting audio.")) {
        this.manifest.warnings.push("System audio recorder unavailable; using microphone-only meeting audio.");
      }
    }

    this.currentChunk = {
      child,
      path: chunkPath,
      micPath,
      systemPath: activeSystemPath,
      systemRecorder,
      index,
      startedAt
    };
    this.manifest.chunks.push({
      index,
      path: chunkPath,
      micPath,
      systemPath: activeSystemPath ?? undefined,
      startedAt
    });
    await this.writeManifest();
    await this.waitForReady(child);
    if (!this.stopping) {
      this.chunkTimer = setTimeout(() => {
        this.rotationPromise = this.rotateChunk().finally(() => {
          this.rotationPromise = null;
        });
      }, this.chunkMs);
    }
  }

  private async rotateChunk(): Promise<void> {
    if (this.stopping || !this.currentChunk) return;
    await this.stopCurrentChunk();
    await this.startChunk();
  }

  private async stopCurrentChunk(): Promise<void> {
    const chunk = this.currentChunk;
    if (!chunk || !this.manifest) return;
    this.clearChunkTimer();
    await new Promise<void>((resolve) => {
      if (chunk.child.exitCode !== null) return resolve();
      chunk.child.once("exit", () => resolve());
      chunk.child.kill("SIGTERM");
    });
    if (chunk.systemRecorder) {
      await chunk.systemRecorder.stop().catch((err: unknown) => {
        if (!this.manifest) return;
        const message = err instanceof Error ? err.message : String(err);
        this.manifest.warnings ??= [];
        this.manifest.warnings.push(`System audio stop failed for chunk ${chunk.index + 1}: ${message}`);
      });
    }
    await MeetingAudioMixer.mix({
      micPath: chunk.micPath,
      systemPath: chunk.systemPath ?? undefined,
      outputPath: chunk.path
    });
    const stat = await fs.stat(chunk.path).catch(() => null);
    const entry = this.manifest.chunks.find((item) => item.index === chunk.index);
    if (entry) {
      entry.stoppedAt = new Date().toISOString();
      entry.bytes = stat?.size ?? 0;
    }
    this.currentChunk = null;
    await this.writeManifest();
  }

  private waitForReady(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        child.stdout?.removeListener("data", onData);
        child.stderr?.removeListener("data", onStderr);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        if (err) reject(err);
        else resolve();
      };
      const onData = (): void => finish();
      const onStderr = (chunk: Buffer): void => {
        console.warn("[meeting] recorder stderr:", chunk.toString("utf8").trim());
      };
      const onError = (err: Error): void => finish(err);
      const onExit = (code: number | null): void => {
        finish(new Error(`Meeting audio recorder exited before ready (${code ?? "signal"}).`));
      };
      child.stdout?.once("data", onData);
      child.stderr?.on("data", onStderr);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  }

  private clearChunkTimer(): void {
    if (this.chunkTimer) {
      clearTimeout(this.chunkTimer);
      this.chunkTimer = null;
    }
  }

  private async writeManifest(): Promise<void> {
    if (!this.manifest) return;
    const manifestPath = path.join(this.manifest.folder, "manifest.json");
    await fs.writeFile(manifestPath, `${JSON.stringify(this.manifest, null, 2)}\n`, "utf8");
  }
}

function formatStamp(date: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}
