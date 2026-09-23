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
import { systemPreferences } from "electron";

import { assertScreenRecordingGranted, readRegionText } from "./ocr-context.ts";
import { shouldAcceptMouse, type OverlayStatus, type OverlayUpdate } from "./overlay-layout.ts";
import { DEFAULT_SEGMENTER_OPTIONS, SpeechSegmenter, type SpeechSegment } from "./segmenter.ts";
import {
  createSummaryStreamer,
  resolveSummaryProvider,
  type SummaryFallbackNotice,
  type SummaryStreamer
} from "./summarizer.ts";
import { renderSummaryHtml } from "./summary-prompt.ts";
import { SystemAudioTap } from "./system-audio-tap.ts";
import {
  DEFAULT_CAPTIONS_DRAG_MODIFIER,
  DEFAULT_CAPTIONS_PROMPT,
  DEFAULT_CAPTIONS_SILENCE_MS,
  MAX_CAPTIONS_SILENCE_MS,
  MIN_CAPTIONS_SILENCE_MS,
  PROVISIONAL_SILENCE_MS
} from "./captions-defaults.ts";
import { decideSummaryAction, type TurnPolicy } from "./summary-policy.ts";
import {
  isPartialCurrent,
  PartialGate,
  resolvePartialBackend,
  resolvePartialIntervalMs,
  DEFAULT_PARTIAL_INTERVAL_MS
} from "./partial-policy.ts";
import { CONTEXT_DIR_NAME, ReferenceContextCache, type ReferenceContext } from "./context-store.ts";
import { SileroVad } from "./silero-vad.ts";
import { isLikelyHallucination, TranscriptBuffer, type TranscriptPushResult } from "./transcript-buffer.ts";
import { encodeWavPcm16Mono } from "./wav.ts";

// Coalesces segments that land within a breath of each other. Short, because
// with speculative transcription the text is usually ready at the cut and
// every millisecond here is on the critical path (#189).
const SUMMARY_DEBOUNCE_MS = 300;
/** A held half-sentence is shown on its own if nothing completes it within this long. */
const FRAGMENT_HOLD_MS = 4_000;
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
  /** STT for live partial lines; null turns partials off. Defaults from env. */
  partialWhisper?: WhisperBackend | null;
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
  private readonly referenceContext: ReferenceContextCache;
  private lastReference: ReferenceContext = { text: "", files: [], truncated: 0 };
  private language: string | undefined;
  private prompt = DEFAULT_CAPTIONS_PROMPT;
  private providerHint = "";
  /** Injected in tests; when set, start() does not re-read the environment. */
  private readonly injected: { whisper: boolean; partialWhisper: boolean; summarizer: boolean };

  private segmenter: SpeechSegmenter | null = null;
  private vad: SileroVad | null = null;
  private silenceMs = DEFAULT_CAPTIONS_SILENCE_MS;
  /** Digital-silence floor under the classifier; tunable on a live call. */
  private classifierMinRms = DEFAULT_SEGMENTER_OPTIONS.classifierMinRms;
  private vadChoice: "silero" | "energy" = "silero";
  private turnPolicy: TurnPolicy = "interrupt";
  private mixMicrophone = false;
  /** What the helper said about the microphone: on, off, or why not. */
  private micState: "off" | "on" | "denied" | "unavailable" = "off";
  private speculativeStt = true;
  /** Result of a speculative transcription of the utterance still open. */
  private provisional: { utteranceId: number; speechMs: number; text: string } | null = null;
  /** STT for the live partial line (#203); null when partials are off. */
  private partialWhisper: WhisperBackend | null = null;
  private partialIntervalMs = DEFAULT_PARTIAL_INTERVAL_MS;
  private readonly partialGate = new PartialGate();
  /** The open utterance as transcribed so far — shown, never stored. */
  private partialText = "";
  private partialUtteranceId = 0;
  /** Newest utterance whose final segment has been taken up. */
  private lastFinalUtteranceId = 0;
  private summaryQueued = false;
  private summaryStale = false;
  private dragHotkey: PushToTalkBackend | null = null;
  private state: CaptionsState = "stopped";
  private status: OverlayStatus = "stopped";
  private hint = "";
  private modifierHeld = false;
  private moveModeToggled = false;

  private transcribeQueue: SpeechSegment[] = [];
  private transcribing = false;
  private summaryTimer: NodeJS.Timeout | null = null;
  private fragmentTimer: NodeJS.Timeout | null = null;
  private summaryAbort: AbortController | null = null;
  private summaryText = "";
  private summaryStreaming = false;
  private ocrBusy = false;

  constructor(options: CaptionsServiceOptions) {
    super();
    this.window = new CaptionsWindow(options.preloadPath, options.userDataDir);
    this.tap = options.audioTap ?? new SystemAudioTap();
    this.injected = {
      whisper: options.whisper !== undefined,
      partialWhisper: options.partialWhisper !== undefined,
      summarizer: options.summarizer !== undefined
    };
    this.partialWhisper = options.partialWhisper ?? null;
    this.whisper = options.whisper ?? createWhisperBackend("whisper-cpp");
    this.summarizer = options.summarizer ?? null;
    this.pickRegion = options.pickRegion;
    this.referenceContext = new ReferenceContextCache(
      process.env.MARSHAL_CAPTIONS_CONTEXT_DIR?.trim() || path.join(options.userDataDir, CONTEXT_DIR_NAME)
    );
    this.configureFromEnv();

    this.tap.on("error", (err: Error) => {
      console.warn("[captions] audio tap error:", err.message);
      this.setStatus("error", err.message);
    });
    this.tap.on("mic", ({ on, reason }: { on: boolean; reason?: string }) => {
      this.micState = on ? "on" : "unavailable";
      if (!on) console.warn("[captions] microphone mixing unavailable:", reason ?? "unknown");
      if (this.state === "running") this.setStatus(this.status, this.idleHint());
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
    const sttBackend = resolveBackendName(process.env.MARSHAL_CAPTIONS_STT_BACKEND ?? process.env.MARSHAL_DICTATION_BACKEND);
    if (!this.injected.whisper) {
      this.whisper = createWhisperBackend(sttBackend);
    }
    if (!this.injected.partialWhisper) {
      const partialBackend = resolvePartialBackend(process.env.MARSHAL_CAPTIONS_PARTIALS, sttBackend);
      this.partialWhisper = partialBackend ? createWhisperBackend(partialBackend) : null;
    }
    this.partialIntervalMs = resolvePartialIntervalMs(process.env.MARSHAL_CAPTIONS_PARTIAL_MS);
    if (!this.injected.summarizer) {
      this.summarizer = createSummaryStreamer(process.env, (notice) => this.onSummaryFallback(notice));
    }
    this.language = resolveDictationLanguage(
      process.env.MARSHAL_CAPTIONS_LANGUAGE ?? process.env.MARSHAL_DICTATION_LANGUAGE ?? "auto"
    );
    const promptEnv = process.env.MARSHAL_CAPTIONS_PROMPT;
    this.prompt = typeof promptEnv === "string" ? promptEnv.trim() : DEFAULT_CAPTIONS_PROMPT;
    const provider = resolveSummaryProvider(process.env);
    this.providerHint = provider.id === "off" ? `captions only — ${provider.reason}` : `summary: ${provider.id}`;
    const silence = Number.parseInt(process.env.MARSHAL_CAPTIONS_SILENCE_MS ?? "", 10);
    this.silenceMs = Number.isFinite(silence)
      ? Math.min(Math.max(silence, MIN_CAPTIONS_SILENCE_MS), MAX_CAPTIONS_SILENCE_MS)
      : DEFAULT_CAPTIONS_SILENCE_MS;
    // Raising this makes the classifier deaf to quiet speech and cuts
    // sentences in half (#202); lowering it lets the model fire on the noise
    // floor. Exposed because the right value depends on how loud the other
    // side of the call is, which cannot be guessed from here.
    const minRms = Number.parseInt(process.env.MARSHAL_CAPTIONS_MIN_RMS ?? "", 10);
    this.classifierMinRms = Number.isFinite(minRms) && minRms >= 0
      ? Math.min(minRms, DEFAULT_SEGMENTER_OPTIONS.minSpeechRms)
      : DEFAULT_SEGMENTER_OPTIONS.classifierMinRms;
    this.vadChoice = (process.env.MARSHAL_CAPTIONS_VAD ?? "silero").trim().toLowerCase() === "energy" ? "energy" : "silero";
    this.turnPolicy = (process.env.MARSHAL_CAPTIONS_TURN_POLICY ?? "interrupt").trim().toLowerCase() === "queue" ? "queue" : "interrupt";
    this.speculativeStt = (process.env.MARSHAL_CAPTIONS_SPECULATIVE_STT ?? "1").trim() !== "0";
    this.mixMicrophone = (process.env.MARSHAL_CAPTIONS_MIX_MIC ?? "0").trim() === "1";
  }

  /**
   * Silero runs on WASM and loads asynchronously; when it cannot (a broken
   * install, an unsupported platform) the energy gate takes over and the
   * overlay hint says so, rather than captions silently degrading.
   */
  private async createSegmenter(): Promise<SpeechSegmenter> {
    this.vad?.dispose();
    this.vad = null;
    let classifyFrame: ((frame: Int16Array, rms: number) => boolean) | undefined;
    if (this.vadChoice === "silero") {
      try {
        const vad = await SileroVad.create();
        this.vad = vad;
        classifyFrame = (frame) => vad.classify(frame);
      } catch (err) {
        console.warn("[captions] Silero VAD unavailable, using the energy gate:", err instanceof Error ? err.message : err);
        this.vadChoice = "energy";
      }
    }
    return new SpeechSegmenter((segment) => this.enqueueSegment(segment), {
      silenceEndMs: this.silenceMs,
      classifierMinRms: this.classifierMinRms,
      partialIntervalMs: this.partialWhisper ? this.partialIntervalMs : 0,
      // Speculate only when the real pause is long enough for it to pay off.
      provisionalSilenceMs: this.speculativeStt && this.silenceMs > PROVISIONAL_SILENCE_MS * 2 ? PROVISIONAL_SILENCE_MS : 0,
      classifyFrame
    });
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

      this.segmenter = await this.createSegmenter();
      const onPcm = (chunk: Buffer): void => {
        this.segmenter?.pushBytes(chunk);
      };
      this.tap.on("pcm", onPcm);
      // The microphone is opt-in (#191): the helper mixes it in only when
      // asked, and only after macOS granted the app the microphone — the
      // prompt is triggered here so it appears at the moment it makes sense.
      let microphone = false;
      this.micState = "off";
      if (this.mixMicrophone) {
        microphone = process.platform === "darwin" ? await systemPreferences.askForMediaAccess("microphone") : true;
        if (!microphone) {
          this.micState = "denied";
          console.warn("[captions] microphone access denied — captions continue with system audio only");
        }
      }
      try {
        await this.tap.start({
          microphone,
          microphoneDevice: (process.env.MARSHAL_DICTATION_MIC ?? "").trim() || undefined
        });
      } catch (err) {
        this.tap.off("pcm", onPcm);
        throw err;
      }
      this.startDragHotkey();
      this.lastReference = await this.referenceContext.get().catch(() => this.lastReference);
      this.setState("running");
      this.setStatus("listening", this.idleHint());
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
    if (segment.reason === "partial") {
      void this.transcribePartial(segment);
      return;
    }
    // A provisional copy is only worth keeping while nothing newer waits:
    // drop queued provisionals when another arrives or the final lands, and
    // never let a provisional push out a final.
    if (segment.reason === "provisional") {
      this.transcribeQueue = this.transcribeQueue.filter((queued) => queued.reason !== "provisional");
      this.transcribeQueue.push(segment);
    } else {
      this.transcribeQueue = this.transcribeQueue.filter(
        (queued) => !(queued.reason === "provisional" && queued.utteranceId === segment.utteranceId)
      );
      this.transcribeQueue.push(segment);
      while (this.transcribeQueue.filter((queued) => queued.reason !== "provisional").length > MAX_TRANSCRIBE_BACKLOG) {
        const index = this.transcribeQueue.findIndex((queued) => queued.reason !== "provisional");
        this.transcribeQueue.splice(index, 1);
        console.warn("[captions] whisper backlog — dropped oldest segment");
      }
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
    // The speculative pass already transcribed exactly this speech: the
    // utterance closed without another word, so its text stands and the
    // whisper round trip is skipped — that is where the sub-second turn
    // latency comes from (#189).
    if (segment.reason !== "provisional") {
      // From here on a partial for this utterance is older than what is coming.
      this.lastFinalUtteranceId = Math.max(this.lastFinalUtteranceId, segment.utteranceId);
    }
    const provisional = this.provisional;
    if (
      segment.reason !== "provisional" &&
      provisional &&
      provisional.utteranceId === segment.utteranceId &&
      provisional.speechMs === segment.speechMs
    ) {
      this.provisional = null;
      this.dropPartial(segment.utteranceId);
      this.applyTranscript(this.buffer.pushTranscript(provisional.text));
      if (!this.summaryStreaming) this.setStatus("listening");
      return;
    }
    if (segment.reason !== "provisional") this.provisional = null;

    const wavPath = path.join(tmpdir(), `marshal-captions-${randomUUID()}.wav`);
    if (segment.reason !== "provisional") this.setStatus("transcribing");
    try {
      await fs.writeFile(wavPath, encodeWavPcm16Mono(segment.samples));
      const result = await this.whisper.transcribe(wavPath, { language: this.language, prompt: this.prompt });
      if (this.state !== "running") return;
      if (segment.reason === "provisional") {
        this.provisional = { utteranceId: segment.utteranceId, speechMs: segment.speechMs, text: result.text };
        return;
      }
      this.dropPartial(segment.utteranceId);
      this.applyTranscript(this.buffer.pushTranscript(result.text));
      if (!this.summaryStreaming) this.setStatus("listening");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (segment.reason !== "provisional") this.dropPartial(segment.utteranceId);
      console.warn("[captions] transcription failed:", message);
      this.setStatus("listening", `transcription failed: ${message.split("\n")[0].slice(0, 120)}`);
    } finally {
      await fs.unlink(wavPath).catch(() => undefined);
    }
  }

  /**
   * Transcribes the utterance still being spoken and shows it as the live
   * line (#203). Display only: nothing here touches the transcript buffer
   * or the summary, and a partial never waits in — or delays — the final
   * queue. See partial-policy.ts for the admission rules.
   */
  private async transcribePartial(segment: SpeechSegment): Promise<void> {
    const partialWhisper = this.partialWhisper;
    if (!partialWhisper || this.state !== "running") return;
    const finalsPending = this.transcribing || this.transcribeQueue.length > 0;
    if (!this.partialGate.tryBegin(Date.now(), finalsPending)) return;

    const wavPath = path.join(tmpdir(), `marshal-captions-partial-${randomUUID()}.wav`);
    let ok = true;
    try {
      await fs.writeFile(wavPath, encodeWavPcm16Mono(segment.samples));
      const result = await partialWhisper.transcribe(wavPath, { language: this.language, prompt: this.prompt });
      if (this.state !== "running") return;
      if (!isPartialCurrent(segment.utteranceId, this.lastFinalUtteranceId)) return;
      const text = result.text.trim().replace(/\s+/gu, " ");
      if (isLikelyHallucination(text)) return;
      this.partialText = text;
      this.partialUtteranceId = segment.utteranceId;
      this.pushUpdate();
    } catch (err) {
      ok = false;
      // Most likely a rate limit. Partials go quiet for the cool-down so the
      // quota is left to the final captions; say so once, not per request.
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[captions] partial transcription failed, pausing partials:", message.split("\n")[0].slice(0, 160));
    } finally {
      this.partialGate.end(ok, Date.now());
      await fs.unlink(wavPath).catch(() => undefined);
    }
  }

  /** Clears the live line once the final for its utterance has been taken up. */
  private dropPartial(utteranceId: number): void {
    if (!this.partialText || this.partialUtteranceId > utteranceId) return;
    this.partialText = "";
    this.partialUtteranceId = 0;
    this.pushUpdate();
  }

  /**
   * A stored line updates the overlay and schedules the summary: at once when
   * the line is a question — a question closes a speaker's turn, so there is
   * nothing to wait for — and after the debounce otherwise. The summary is
   * the same scribe summary either way (#211). A held fragment starts a timer
   * that stores it alone if no continuation arrives.
   */
  private applyTranscript(result: TranscriptPushResult): void {
    this.clearFragmentTimer();
    if (result.held) {
      this.fragmentTimer = setTimeout(() => {
        this.fragmentTimer = null;
        this.applyTranscript(this.buffer.flushFragment());
      }, FRAGMENT_HOLD_MS);
      return;
    }
    if (!result.accepted) return;
    // The bullets on screen no longer cover the transcript; say so until the
    // replacement has its first words.
    if (this.summaryText.length > 0) this.summaryStale = true;
    this.pushUpdate();
    this.scheduleSummary(result.question ? 0 : SUMMARY_DEBOUNCE_MS);
  }

  /**
   * `auto` picked a summary provider that cannot serve requests (#214) and the
   * streamer switched to the next one. Said once — in the log and in the
   * overlay hint — because a silently different provider is how a summary
   * ends up slower or in another style with nobody knowing why.
   */
  private onSummaryFallback(notice: SummaryFallbackNotice): void {
    const why = { auth: "key rejected", credit: "no credits", model: "model not found" }[notice.reason];
    console.warn(`[captions] summary: ${notice.from} unusable (${why}); using ${notice.to}`);
    this.providerHint = `summary: ${notice.to} (${notice.from}: ${why})`;
  }

  private clearFragmentTimer(): void {
    if (this.fragmentTimer) {
      clearTimeout(this.fragmentTimer);
      this.fragmentTimer = null;
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
    const action = decideSummaryAction({ policy: this.turnPolicy, streaming: this.summaryStreaming });
    if (action === "queue") {
      // Let the current bullets finish; one follow-up request covers
      // everything that arrives meanwhile.
      this.summaryQueued = true;
      return;
    }
    this.summaryQueued = false;
    if (action === "restart") this.summaryAbort?.abort();
    const controller = new AbortController();
    this.summaryAbort = controller;

    // Re-checked before every summary: an edited agenda or glossary applies
    // at once, and the check is a readdir plus stats, not a re-read.
    this.lastReference = await this.referenceContext.get().catch(() => this.lastReference);
    const input = {
      transcript: this.buffer.transcriptText(),
      ocrContext: this.buffer.ocrText(),
      outputLanguage: process.env.MARSHAL_CAPTIONS_OUTPUT_LANGUAGE ?? "",
      referenceContext: this.lastReference.text
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
          this.summaryStale = false;
          this.pushUpdate();
        },
        controller.signal
      );
      if (!controller.signal.aborted) {
        this.summaryText = streamed;
        this.summaryStreaming = false;
        this.setStatus("listening", this.idleHint());
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      this.summaryStreaming = false;
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[captions] summary failed:", message);
      this.setStatus("listening", `summary failed: ${message.split("\n")[0].slice(0, 120)}`);
    } finally {
      if (this.summaryAbort === controller) this.summaryAbort = null;
      // `queue` policy: transcript that arrived during this request gets its
      // own, single follow-up now.
      if (!controller.signal.aborted && this.summaryQueued && this.state === "running") {
        this.summaryQueued = false;
        void this.runSummary();
      }
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

  /** What the overlay shows while waiting for speech: provider, detector, pause, reference files. */
  private idleHint(): string {
    const files = this.lastReference.files.filter((file) => file.included > 0).length;
    const context = files > 0 ? ` · ctx: ${files} file${files === 1 ? "" : "s"}` : "";
    const turn = this.turnPolicy === "queue" ? " · queue" : "";
    const mic = this.micState === "on" ? " · mic" : this.micState === "off" ? "" : ` · mic ${this.micState}`;
    return `${this.providerHint} · vad: ${this.vadChoice} · pause ${this.silenceMs} ms${turn}${mic}${context}`;
  }

  /** Where the user drops reference files; created on demand by the Settings button. */
  get referenceContextDir(): string {
    return this.referenceContext.directory;
  }

  /** Current reference files, for Settings. */
  async describeReferenceContext(): Promise<ReferenceContext> {
    this.lastReference = await this.referenceContext.get();
    return this.lastReference;
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
      partial: this.partialText,
      summaryHtml: renderSummaryHtml(this.summaryText),
      summaryStreaming: this.summaryStreaming,
      summaryStale: this.summaryStale,
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
    this.clearFragmentTimer();
    this.summaryQueued = false;
    this.summaryStale = false;
    this.provisional = null;
    this.partialText = "";
    this.partialUtteranceId = 0;
    this.lastFinalUtteranceId = 0;
    this.partialGate.reset();
    this.transcribeQueue = [];
    this.tap.removeAllListeners("pcm");
    this.tap.stop();
    this.segmenter = null;
    this.vad?.dispose();
    this.vad = null;
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
