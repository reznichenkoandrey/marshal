import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { VideoRecorder } from "../capture/video-recorder.ts";
import { asarUnpacked } from "../utils/asar-paths.ts";
import { buildMeetingMuxArgs, buildTimelineToAacArgs, MeetingAudioMixer } from "./audio-mixer.ts";
import { SystemAudioRecorder } from "./system-audio-recorder.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const DEFAULT_RECORDER_BIN = path.join(
  asarUnpacked(path.resolve(desktopDistDir, "..", "dictation")),
  "audio-recorder"
);
const DEFAULT_CHUNK_MS = 5 * 60 * 1000;

export const MEETING_AUDIO_FILE = "meeting.m4a";
export const MEETING_VIDEO_FILE = "meeting.mp4";
const RAW_SCREEN_FILE = "screen.mov";

export type MeetingMode = "audio" | "screen";

export type MeetingRecordingEvents = {
  "recording-start": [{ mode: MeetingMode }];
  saved: [{ session: MeetingSessionSummary }];
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
  mode: MeetingMode;
  state: "recording" | "finalizing" | "done" | "error";
  source: "microphone" | "microphone+system";
  startedAt: string;
  stoppedAt?: string;
  folder: string;
  chunks: MeetingChunkManifest[];
  videoStartedAt?: string;
  warnings?: string[];
  audioPath?: string;
  videoPath?: string;
  error?: string;
};

export type MeetingSessionSummary = {
  id: string;
  folder: string;
  audioPath: string;
  videoPath?: string;
};

type ActiveChunk = {
  child: ChildProcess;
  path: string;
  micPath: string;
  systemPath: string | null;
  systemRecorder: SystemAudioRecorder | null;
  index: number;
};

type MeetingRecorderOptions = {
  userDataDir: string;
  recorderBin?: string;
  chunkMs?: number;
};

export class MeetingRecorder extends EventEmitter {
  private readonly userDataDir: string;
  private readonly recorderBin: string;
  private readonly chunkMs: number;
  private readonly systemAudioRecorder: SystemAudioRecorder | null;
  private manifest: MeetingManifest | null = null;
  private currentChunk: ActiveChunk | null = null;
  private videoRecorder: VideoRecorder | null = null;
  private chunkTimer: NodeJS.Timeout | null = null;
  private rotationPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(options: MeetingRecorderOptions) {
    super();
    this.userDataDir = options.userDataDir;
    this.recorderBin = options.recorderBin ?? process.env.MARSHAL_DICTATION_RECORDER_BIN ?? DEFAULT_RECORDER_BIN;
    const systemRecorder = new SystemAudioRecorder();
    this.systemAudioRecorder = systemRecorder.isAvailable() ? systemRecorder : null;
    const configuredChunkMs = Number.parseInt(process.env.MARSHAL_MEETING_CHUNK_MS ?? "", 10);
    this.chunkMs = options.chunkMs ?? (Number.isFinite(configuredChunkMs) && configuredChunkMs > 0
      ? configuredChunkMs
      : DEFAULT_CHUNK_MS);
  }

  static meetingsDir(userDataDir: string): string {
    return path.join(userDataDir, "meetings");
  }

  activeId(): string | null {
    return this.manifest?.id ?? null;
  }

  isRecording(): boolean {
    return this.manifest?.state === "recording" || this.manifest?.state === "finalizing";
  }

  async start(mode: MeetingMode): Promise<MeetingManifest> {
    if (this.isRecording() || this.currentChunk) {
      throw new Error("Meeting recording is already active.");
    }
    if (!existsSync(this.recorderBin)) {
      throw new Error(`Meeting recorder binary missing at ${this.recorderBin}. Run \`npm run build\`.`);
    }
    if (mode === "screen" && !VideoRecorder.isAvailable()) {
      throw new Error("screen-recorder binary missing. Run `npm run build`.");
    }

    try {
      this.stopping = false;
      const now = new Date();
      const id = `meeting-${formatStamp(now)}-${randomUUID().slice(0, 8)}`;
      const folder = path.join(MeetingRecorder.meetingsDir(this.userDataDir), id);
      await fs.mkdir(folder, { recursive: true });
      this.manifest = {
        id,
        mode,
        state: "recording",
        source: this.systemAudioRecorder ? "microphone+system" : "microphone",
        startedAt: now.toISOString(),
        folder,
        chunks: []
      };
      await this.writeManifest();
      if (mode === "screen") await this.startVideo(path.join(folder, RAW_SCREEN_FILE));
      await this.startChunk();
      this.emit("recording-start", { mode });
      return this.manifest;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.clearChunkTimer();
      this.killCurrentChunk();
      this.killVideo();
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
    if (!this.manifest || this.stopping) return null;
    try {
      this.stopping = true;
      this.clearChunkTimer();
      if (this.rotationPromise) await this.rotationPromise;
      if (this.currentChunk) await this.stopCurrentChunk();
      const rawVideoPath = await this.stopVideo();

      const manifest = this.manifest;
      manifest.state = "finalizing";
      manifest.stoppedAt = new Date().toISOString();
      await this.writeManifest();

      const recorded = manifest.chunks.filter((chunk) => (chunk.bytes ?? 0) > 0);
      const timelineStart = Date.parse(recorded[0]?.startedAt ?? manifest.startedAt);
      const audioPath = path.join(manifest.folder, MEETING_AUDIO_FILE);
      await MeetingAudioMixer.run(
        buildTimelineToAacArgs(
          recorded.map((chunk) => ({ path: chunk.path, offsetMs: Date.parse(chunk.startedAt) - timelineStart })),
          audioPath
        ),
        "meeting audio assembly"
      );
      manifest.audioPath = audioPath;

      let videoPath: string | undefined;
      if (rawVideoPath && manifest.videoStartedAt) {
        videoPath = path.join(manifest.folder, MEETING_VIDEO_FILE);
        await MeetingAudioMixer.run(
          buildMeetingMuxArgs({
            videoPath: rawVideoPath,
            audioPath,
            audioOffsetSec: (timelineStart - Date.parse(manifest.videoStartedAt)) / 1000,
            outputPath: videoPath
          }),
          "meeting video mux"
        );
        manifest.videoPath = videoPath;
        await fs.rm(rawVideoPath, { force: true });
      }

      // Raw chunks go only after the final files exist: until then they are
      // the only copy of the call.
      await Promise.all(
        manifest.chunks.flatMap((chunk) =>
          [chunk.path, chunk.micPath, chunk.systemPath].filter((p): p is string => Boolean(p)).map((p) => fs.rm(p, { force: true }))
        )
      );
      manifest.chunks = [];
      manifest.state = "done";
      await this.writeManifest();

      const session: MeetingSessionSummary = { id: manifest.id, folder: manifest.folder, audioPath, videoPath };
      this.emit("saved", { session });
      return session;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.manifest) {
        this.manifest.state = "error";
        this.manifest.error = error.message;
        await this.writeManifest().catch(() => undefined);
      }
      this.emit("error", error);
      return null;
    } finally {
      this.killVideo();
      this.manifest = null;
      this.stopping = false;
    }
  }

  kill(): void {
    this.stopping = true;
    this.clearChunkTimer();
    this.killCurrentChunk();
    this.killVideo();
    this.manifest = null;
  }

  private async startVideo(outPath: string): Promise<void> {
    const recorder = new VideoRecorder();
    this.videoRecorder = recorder;
    // VideoRecorder emits "error" for mid-recording failures; without a
    // listener EventEmitter would throw it out of the stdout handler.
    recorder.on("error", (err: Error) => {
      console.error("[meeting] screen recorder:", err.message);
      if (!this.manifest) return;
      this.manifest.warnings ??= [];
      this.manifest.warnings.push(`Screen recording: ${err.message}`);
    });
    await recorder.startMeeting(outPath);
    if (this.manifest) this.manifest.videoStartedAt = new Date().toISOString();
  }

  private async stopVideo(): Promise<string | null> {
    const recorder = this.videoRecorder;
    if (!recorder?.isRecording) return null;
    try {
      return await recorder.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.manifest?.warnings?.push(`Screen recording stop failed: ${message}`);
      return null;
    }
  }

  private killVideo(): void {
    this.videoRecorder?.kill();
    this.videoRecorder = null;
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
      index
    };
    await this.waitForReady(child);
    // Stamped once the microphone is actually capturing: this is the chunk's
    // position on the timeline the final audio and the screen video share.
    this.manifest.chunks.push({
      index,
      path: chunkPath,
      micPath,
      systemPath: activeSystemPath ?? undefined,
      startedAt: new Date().toISOString()
    });
    await this.writeManifest();
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
    // The next chunk starts before the finished one is mixed: the mix takes
    // seconds, and every one of them would be a hole in the recording.
    const ended = await this.endCurrentChunk();
    await this.startChunk();
    if (ended) await this.finalizeChunk(ended);
  }

  private async stopCurrentChunk(): Promise<void> {
    const ended = await this.endCurrentChunk();
    if (ended) await this.finalizeChunk(ended);
  }

  private async endCurrentChunk(): Promise<ActiveChunk | null> {
    const chunk = this.currentChunk;
    if (!chunk || !this.manifest) return null;
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
    this.currentChunk = null;
    return chunk;
  }

  private async finalizeChunk(chunk: ActiveChunk): Promise<void> {
    if (!this.manifest) return;
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
