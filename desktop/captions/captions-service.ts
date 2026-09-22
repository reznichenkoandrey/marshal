// desktop/captions/captions-service.ts
//
// Orchestrates the live captions pipeline:
//
//   system-audio-tap ─► SpeechSegmenter ─► WhisperBackend ─► TranscriptBuffer
//                                                                  │
//                        CaptionsWindow ◄── summary stream ◄───────┘
//                              ▲
//                     OCR hotkey (region → Vision) ─────────────────┘
//
// Every stage is bounded on purpose: at most one whisper process at a time
// with a short backlog (a stale caption is worse than a dropped one), and
// one summary request in flight (a newer transcript aborts the old one).

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createWhisperBackend,
  resolveBackendName,
  resolveDictationLanguage,
  type WhisperBackend
} from "../dictation/whisper-backend.ts";
import { PushToTalkHotkey, type PushToTalkBackend } from "../dictation/hotkey-manager.ts";
import { isSwiftPttCandidate, SwiftPushToTalkHotkey } from "../dictation/swift-ptt-monitor.ts";
import { CaptionsWindow, type OcrRegion } from "./captions-window.ts";
import { assertScreenRecordingGranted, readRegionText } from "./ocr-context.ts";
import { shouldAcceptMouse, type OverlayStatus, type OverlayUpdate } from "./overlay-layout.ts";
import { SpeechSegmenter, type SpeechSegment } from "./segmenter.ts";
import { createSummaryStreamer, resolveSummaryProvider, type SummaryStreamer } from "./summarizer.ts";
import { renderSummaryHtml } from "./summary-prompt.ts";
import { SystemAudioTap } from "./system-audio-tap.ts";
import { DEFAULT_CAPTIONS_DRAG_MODIFIER, DEFAULT_CAPTIONS_PROMPT } from "./captions-defaults.ts";
import { TranscriptBuffer } from "./transcript-buffer.ts";
import { encodeWavPcm16Mono } from "./wav.ts";

const SUMMARY_DEBOUNCE_MS = 600;
/** Segments waiting for whisper beyond this are dropped, oldest first. */
const MAX_TRANSCRIBE_BACKLOG = 2;

export type CaptionsState = "stopped" | "starting" | "running";

export type CaptionsServiceEvents = {
  "state-change": [CaptionsState];
  error: [Error];
};

export interface CaptionsServiceOptions {
  preloadPath: string;
  userDataDir: string;
  /** Opens the crop overlay and resolves with the chosen region (DIP). */
  pickRegion: () => Promise<OcrRegion | null>;
  whisper?: WhisperBackend;
  summarizer?: SummaryStreamer | null;
  audioTap?: SystemAudioTap;
}

export class LiveCaptionsService extends EventEmitter {
  private readonly window: CaptionsWindow;
  private readonly tap: SystemAudioTap;
  private whisper: WhisperBackend;
  private summarizer: SummaryStreamer | null;
  private readonly pickRegion: () => Promise<OcrRegion | null>;
  private readonly buffer = new TranscriptBuffer();
  private language: string | undefined;
  private prompt = DEFAULT_CAPTIONS_PROMPT;
  private providerHint = "";
  /** Injected in tests; when set, start() does not re-read the environment. */
  private readonly injected: { whisper: boolean; summarizer: boolean };

  private segmenter: SpeechSegmenter | null = null;
  private dragHotkey: PushToTalkBackend | null = null;
  private state: CaptionsState = "stopped";
  private status: OverlayStatus = "stopped";
  private hint = "";
  private modifierHeld = false;
  private moveModeToggled = false;

  private transcribeQueue: SpeechSegment[] = [];
  private transcribing = false;
  private summaryTimer: NodeJS.Timeout | null = null;
  private summaryAbort: AbortController | null = null;
  private summaryText = "";
  private summaryStreaming = false;
  private ocrBusy = false;

  constructor(options: CaptionsServiceOptions) {
    super();
    this.window = new CaptionsWindow(options.preloadPath, options.userDataDir);
    this.tap = options.audioTap ?? new SystemAudioTap();
    this.injected = { whisper: options.whisper !== undefined, summarizer: options.summarizer !== undefined };
    this.whisper = options.whisper ?? createWhisperBackend("whisper-cpp");
    this.summarizer = options.summarizer ?? null;
    this.pickRegion = options.pickRegion;
    this.configureFromEnv();

    this.tap.on("error", (err: Error) => {
      console.warn("[captions] audio tap error:", err.message);
      this.setStatus("error", err.message);
    });
    this.tap.on("exit", (code: number | null) => {
      if (this.state === "running") {
        this.setStatus("error", `audio tap exited (${code ?? "signal"}) — stop and start captions again`);
      }
    });
  }

  /**
   * Settings are applied to the environment on save (settings-store.ts), so
   * reading the env at every start — not once in the constructor — is what
   * makes a Settings change take effect without restarting the app (#179).
   */
  private configureFromEnv(): void {
    if (!this.injected.whisper) {
      this.whisper = createWhisperBackend(
        resolveBackendName(process.env.MARSHAL_CAPTIONS_STT_BACKEND ?? process.env.MARSHAL_DICTATION_BACKEND)
      );
    }
    if (!this.injected.summarizer) this.summarizer = createSummaryStreamer(process.env);
    this.language = resolveDictationLanguage(
      process.env.MARSHAL_CAPTIONS_LANGUAGE ?? process.env.MARSHAL_DICTATION_LANGUAGE ?? "auto"
    );
    const promptEnv = process.env.MARSHAL_CAPTIONS_PROMPT;
    this.prompt = typeof promptEnv === "string" ? promptEnv.trim() : DEFAULT_CAPTIONS_PROMPT;
    const provider = resolveSummaryProvider(process.env);
    this.providerHint = provider.id === "off" ? `captions only — ${provider.reason}` : `summary: ${provider.id}`;
  }

  isAvailable(): boolean {
    return this.tap.isAvailable();
  }

  isRunning(): boolean {
    return this.state !== "stopped";
  }

  getState(): CaptionsState {
    return this.state;
  }

  async toggle(): Promise<void> {
    if (this.isRunning()) this.stop();
    else await this.start();
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") return;
    this.setState("starting");
    try {
      assertScreenRecordingGranted();
      this.configureFromEnv();
      this.buffer.clear();
      this.summaryText = "";
      this.transcribeQueue = [];
      this.window.show();
      this.setStatus("starting", "starting audio tap…");

      this.segmenter = new SpeechSegmenter((segment) => this.enqueueSegment(segment));
      const onPcm = (chunk: Buffer): void => {
        this.segmenter?.pushBytes(chunk);
      };
      this.tap.on("pcm", onPcm);
      try {
        await this.tap.start();
      } catch (err) {
        this.tap.off("pcm", onPcm);
        throw err;
      }
      this.startDragHotkey();
      this.setState("running");
      this.setStatus("listening", this.providerHint);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.teardown();
      this.setState("stopped");
      this.emit("error", error);
      throw error;
    }
  }

  stop(): void {
    if (this.state === "stopped") return;
    this.teardown();
    this.setState("stopped");
  }

  /** Tray fallback for users without the modifier listener. */
  toggleMoveMode(): boolean {
    this.moveModeToggled = !this.moveModeToggled;
    this.applyInteractive();
    return this.moveModeToggled;
  }

  isMoveMode(): boolean {
    return this.moveModeToggled;
  }

  resetOverlayPosition(): void {
    this.window.resetPosition();
  }

  resetOcrRegion(): void {
    this.window.setOcrRegion(null);
    this.setStatus(this.status, "OCR region cleared — next Ctrl+Shift+S picks a new one");
  }

  /**
   * The OCR hotkey. First press defines the region with the crop overlay;
   * every later press captures it silently and feeds the summarizer.
   */
  async captureOcrContext(): Promise<void> {
    if (this.state !== "running" || this.ocrBusy) return;
    this.ocrBusy = true;
    try {
      let region = this.window.getOcrRegion();
      if (!region) {
        region = await this.window.withHidden(() => this.pickRegion());
        if (!region) return;
        this.window.setOcrRegion(region);
      }
      const text = await this.window.withHidden(() => readRegionText(region!));
      if (!this.buffer.pushOcr(text)) {
        this.setStatus(this.status, "OCR found no text in the region");
        return;
      }
      this.setStatus(this.status, `screen context added (${text.length} chars)`);
      this.scheduleSummary(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[captions] OCR failed:", message);
      this.setStatus(this.status, `OCR failed: ${message.split("\n")[0]}`);
    } finally {
      this.ocrBusy = false;
    }
  }

  // ── audio → text ──

  private enqueueSegment(segment: SpeechSegment): void {
    this.transcribeQueue.push(segment);
    while (this.transcribeQueue.length > MAX_TRANSCRIBE_BACKLOG) {
      this.transcribeQueue.shift();
      console.warn("[captions] whisper backlog — dropped oldest segment");
    }
    void this.drainTranscribeQueue();
  }

  private async drainTranscribeQueue(): Promise<void> {
    if (this.transcribing) return;
    this.transcribing = true;
    try {
      while (this.transcribeQueue.length > 0 && this.state === "running") {
        const segment = this.transcribeQueue.shift()!;
        await this.transcribeSegment(segment);
      }
    } finally {
      this.transcribing = false;
    }
  }

  private async transcribeSegment(segment: SpeechSegment): Promise<void> {
    const wavPath = path.join(tmpdir(), `marshal-captions-${randomUUID()}.wav`);
    this.setStatus("transcribing");
    try {
      await fs.writeFile(wavPath, encodeWavPcm16Mono(segment.samples));
      const result = await this.whisper.transcribe(wavPath, { language: this.language, prompt: this.prompt });
      if (this.state !== "running") return;
      if (this.buffer.pushTranscript(result.text)) {
        this.pushUpdate();
        this.scheduleSummary(SUMMARY_DEBOUNCE_MS);
      }
      if (!this.summaryStreaming) this.setStatus("listening");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[captions] transcription failed:", message);
      this.setStatus("listening", `transcription failed: ${message.split("\n")[0].slice(0, 120)}`);
    } finally {
      await fs.unlink(wavPath).catch(() => undefined);
    }
  }

  // ── text → summary ──

  private scheduleSummary(delayMs: number): void {
    if (!this.summarizer || !this.buffer.hasTranscript()) return;
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = null;
      void this.runSummary();
    }, delayMs);
  }

  private async runSummary(): Promise<void> {
    if (!this.summarizer || this.state !== "running") return;
    this.summaryAbort?.abort();
    const controller = new AbortController();
    this.summaryAbort = controller;

    const input = {
      transcript: this.buffer.transcriptText(),
      ocrContext: this.buffer.ocrText(),
      outputLanguage: process.env.MARSHAL_CAPTIONS_OUTPUT_LANGUAGE ?? ""
    };
    let streamed = "";
    this.summaryStreaming = true;
    this.setStatus("summarizing");
    try {
      await this.summarizer.stream(
        input,
        (delta) => {
          if (controller.signal.aborted) return;
          streamed += delta;
          // The previous summary stays on screen until the new one has
          // something to show — no blank flash between requests.
          this.summaryText = streamed;
          this.pushUpdate();
        },
        controller.signal
      );
      if (!controller.signal.aborted) {
        this.summaryText = streamed;
        this.summaryStreaming = false;
        this.setStatus("listening", this.providerHint);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      this.summaryStreaming = false;
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[captions] summary failed:", message);
      this.setStatus("listening", `summary failed: ${message.split("\n")[0].slice(0, 120)}`);
    } finally {
      if (this.summaryAbort === controller) this.summaryAbort = null;
    }
  }

  // ── overlay plumbing ──

  private startDragHotkey(): void {
    const hotkey = (process.env.MARSHAL_CAPTIONS_DRAG_MODIFIER ?? DEFAULT_CAPTIONS_DRAG_MODIFIER).trim();
    if (hotkey.length === 0 || hotkey.toLowerCase() === "off") return;
    let backend: PushToTalkBackend;
    try {
      backend = isSwiftPttCandidate(hotkey) ? new SwiftPushToTalkHotkey(hotkey) : new PushToTalkHotkey(hotkey);
    } catch (err) {
      console.warn("[captions] drag modifier unusable:", err instanceof Error ? err.message : err);
      return;
    }
    backend.on("hold-start", () => {
      this.modifierHeld = true;
      this.applyInteractive();
    });
    backend.on("hold-end", () => {
      this.modifierHeld = false;
      this.applyInteractive();
    });
    backend.on("input-monitoring-silent", () => {
      console.warn("[captions] drag modifier listener is silent — use the tray's \"Move Captions Overlay\"");
    });
    backend.start();
    this.dragHotkey = backend;
  }

  private applyInteractive(): void {
    this.window.setInteractive(
      shouldAcceptMouse({ modifierHeld: this.modifierHeld, moveModeToggled: this.moveModeToggled })
    );
  }

  private setStatus(status: OverlayStatus, hint?: string): void {
    this.status = status;
    if (hint !== undefined) this.hint = hint;
    this.pushUpdate();
  }

  private pushUpdate(): void {
    const update: OverlayUpdate = {
      status: this.status,
      captions: this.buffer.displayLines(),
      summaryHtml: renderSummaryHtml(this.summaryText),
      summaryStreaming: this.summaryStreaming,
      interactive: this.window.isInteractive(),
      hint: this.hint
    };
    this.window.update(update);
  }

  private teardown(): void {
    if (this.summaryTimer) {
      clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
    }
    this.summaryAbort?.abort();
    this.summaryAbort = null;
    this.summaryStreaming = false;
    this.transcribeQueue = [];
    this.tap.removeAllListeners("pcm");
    this.tap.stop();
    this.segmenter = null;
    this.dragHotkey?.stop();
    this.dragHotkey = null;
    this.modifierHeld = false;
    this.moveModeToggled = false;
    this.window.setInteractive(false);
    this.window.hide();
    this.status = "stopped";
  }

  private setState(state: CaptionsState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state-change", state);
  }
}
