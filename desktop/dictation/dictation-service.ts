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

import { createPushToTalkHotkey, type PushToTalkBackend } from "./hotkey-manager.ts";
import { asarUnpacked } from "../utils/asar-paths.ts";
import {
  decideAutoPaste,
  insertTextIntoFocused,
  isAxBlind,
  probeFocusedElement,
  sendPasteKeystroke
} from "./focus-paste.ts";
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
// Upper bound on how long handleHoldEnd will block waiting for the recorder
// to report "ready". AVCaptureSession.startRunning() typically takes 50–300 ms
// on a warm mic, longer on first run while macOS issues the TCC prompt.
// 1500 ms is generous enough to cover both without making a genuine failure
// (recorder crashed silently) feel like a hang.
const RECORDER_READY_MAX_WAIT_MS = 1_500;
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
  // Forwarded from PushToTalkHotkey when uiohook attaches but no keydown
  // events arrive within its silence probe window. Main process turns this
  // into a one-time user notification with a deep link to Privacy & Security
  // → Input Monitoring. Issue #100.
  "input-monitoring-silent": [];
};

function resolveLanguage(raw: string | undefined): string | undefined {
  // Default to Ukrainian. The previous "auto" default let whisper-large-v3
  // pick the language by acoustic similarity, which for Ukrainian speakers
  // with English loanwords + surzhyk consistently misfired to Russian (the
  // model treats Ukrainian-with-English-tech-terms as "Russian-ish slavic"
  // and the resulting transcript is rendered in Russian orthography). Forcing
  // `uk` instructs whisper to output Ukrainian Cyrillic for everything
  // recognised as slavic, while English tokens stay English — this is the
  // behaviour our prompt is tuned for (see DEFAULT_DICTATION_PROMPT).
  //
  // Users who genuinely dictate in another language set MARSHAL_DICTATION_LANGUAGE
  // explicitly (en, ru, pl, ...). Passing "auto" still works as an opt-out.
  const value = (raw ?? "uk").toLowerCase().trim();
  if (!value || value === "auto") return undefined;
  // Whisper language codes are 2-letter ISO 639-1. Keep the first two chars
  // so both "uk" and "uk-UA" work.
  return value.slice(0, 2);
}

// Minimum chunk size for the repeat collapser. Below this we leave the text
// alone — natural language has plenty of short repetition (you you you,
// дуже дуже, ha ha) and we don't want to eat it. Whisper's pathological
// loops are always multi-word, so 24 chars is a safe floor.
const MIN_REPEAT_CHARS = 24;

/**
 * Collapse exact duplicate substrings of >= MIN_REPEAT_CHARS that repeat
 * back-to-back anywhere in the text. whisper.cpp (and to a lesser extent
 * the Groq hosted whisper-large-v3) occasionally loops on the last n-gram
 * when the audio tail is silent / breath-padded or when a long initial
 * prompt over-primes the decoder. Symptom: the transcription contains
 * "…foo bar baz foo bar baz" or ends in "…X X X". This collapses those
 * runs to a single copy.
 *
 * Why not just `--no-context` in whisper-cli? It helps but doesn't fully
 * eliminate the loop, especially on long takes; post-processing is the
 * cheap belt-and-braces layer. Exported for unit tests. Issue #99.
 */
export function collapseRepeats(text: string): string {
  if (text.length < MIN_REPEAT_CHARS * 2) return text;
  // The regex captures any chunk of MIN_REPEAT_CHARS+ characters followed by
  // one or more whitespace-separated copies of itself, anywhere in the text.
  // The `s` flag lets `.` cross newlines; `u` keeps it unicode-safe (Ukrainian
  // glyphs, em-dashes, ellipses). The lazy `*?` keeps the captured chunk as
  // small as possible so we don't accidentally swallow legitimate prefixes.
  const pattern = new RegExp(`(.{${MIN_REPEAT_CHARS},}?)(?:\\s*\\1)+`, "gsu");
  let collapsed = text.replace(pattern, "$1");
  // A single pass usually suffices, but nested repeats can survive — run a
  // second pass and bail when the text stops shrinking.
  let prev = "";
  while (collapsed !== prev) {
    prev = collapsed;
    collapsed = collapsed.replace(pattern, "$1");
  }
  return collapsed;
}

export class DictationService extends EventEmitter {
  private readonly hotkey: PushToTalkBackend;
  private readonly backend: WhisperBackend;
  private readonly recorderBin: string;
  // language / prompt deliberately NOT cached — they're re-read from
  // process.env on every transcription. The Settings UI hot-swaps env vars
  // via applySettingsToEnv() and we want those changes to take effect on
  // the very next hold without restarting the dictation service.
  private recorderProcess: ChildProcess | null = null;
  private currentWavPath: string | null = null;
  private isStopping = false;
  private isTranscribing = false;
  private safetyTimer: NodeJS.Timeout | null = null;
  // True once audio-recorder has printed "ready" — AVCaptureSession armed,
  // the WAV file is open, and audio frames are being written. Reset at the
  // start of each session. Used by finishRecording() to wait out the
  // handshake before sending SIGTERM, otherwise a quick tap produces a
  // 44-byte header-only WAV and the user sees "Audio file is empty". #82.
  private recorderReady = false;

  constructor() {
    super();
    const hotkeyString = process.env.MARSHAL_DICTATION_HOTKEY ?? DEFAULT_HOTKEY;
    // Backend selection happens inside createPushToTalkHotkey: modifier-only
    // hotkeys (the default RightCmd here) go through the Swift helper that
    // sidesteps the Sequoia CGEventTap TCC race; everything else stays on
    // uiohook. The dictation service doesn't care which one is active —
    // both expose the same EventEmitter surface.
    this.hotkey = createPushToTalkHotkey(hotkeyString);
    this.backend = createWhisperBackend(resolveBackendName(process.env.MARSHAL_DICTATION_BACKEND));
    this.recorderBin = process.env.MARSHAL_DICTATION_RECORDER_BIN ?? DEFAULT_RECORDER_BIN;

    this.hotkey.on("hold-start", () => this.handleHoldStart());
    this.hotkey.on("hold-end", () => this.handleHoldEnd());
    this.hotkey.on("input-monitoring-silent", () => this.emit("input-monitoring-silent"));
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

  /**
   * True while audio is being recorded (between recording-start and the WAV
   * file being shipped off to the transcriber). Used by the tray menu and the
   * globalShortcut toggle to decide which action to fire next.
   */
  isCurrentlyRecording(): boolean {
    return this.recorderProcess !== null;
  }

  /**
   * Manual entry point that mirrors a push-to-talk down event. Used by the
   * tray menu's "Start Dictation" and by the globalShortcut toggle when the
   * uiohook key listener cannot fire (e.g. Input Monitoring revoked after a
   * self-signed bundle replace — #84).
   */
  startRecording(): void {
    this.handleHoldStart();
  }

  /**
   * Manual entry point that mirrors a push-to-talk up event. Pairs with
   * startRecording().
   */
  stopRecording(): void {
    this.handleHoldEnd();
  }

  /**
   * Current language passed to the whisper backend. Re-read on every call so
   * Settings changes take effect without restarting the dictation service.
   */
  private get language(): string | undefined {
    return resolveLanguage(process.env.MARSHAL_DICTATION_LANGUAGE);
  }

  /** Current dictation prompt. Same hot-read contract as `language`. */
  private get prompt(): string {
    return resolveDictationPrompt(process.env.MARSHAL_DICTATION_PROMPT);
  }

  /**
   * Convenience for the globalShortcut path — start if idle, stop if already
   * recording. globalShortcut fires a single event per accelerator press, so
   * we can't model push-to-talk with it; toggle is the natural fit.
   */
  toggleRecording(): void {
    if (this.isCurrentlyRecording()) {
      this.stopRecording();
    } else {
      this.startRecording();
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
    // Microphone selection (#95): if MARSHAL_DICTATION_MIC is set, pass it
    // to audio-recorder as `--device <uniqueID>`. Empty / unset → recorder
    // uses the system default input, same behavior as before.
    const micUid = (process.env.MARSHAL_DICTATION_MIC ?? "").trim();
    const recorderArgs = micUid ? [wavPath, "--device", micUid] : [wavPath];
    debug("  spawn recorder:", this.recorderBin, "→", wavPath, micUid ? `(mic=${micUid})` : "");

    const child = spawn(this.recorderBin, recorderArgs, { stdio: ["ignore", "pipe", "pipe"] });
    this.recorderProcess = child;
    this.isStopping = false;
    this.recorderReady = false;

    // Safety net — force stop after MAX_RECORDING_MS if the user's keyup
    // event is ever lost by the OS (#49).
    this.safetyTimer = setTimeout(() => {
      debug("safety timeout — forcing hold-end after", MAX_RECORDING_MS, "ms");
      this.hotkey.forceEnd();
    }, MAX_RECORDING_MS);

    child.stdout?.once("data", () => {
      // "ready" — engine is up. Safe to treat as recording.
      debug("  recorder ready");
      this.recorderReady = true;
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

  /**
   * Resolves once audio-recorder has printed "ready" to stdout (the
   * AVCaptureSession handshake completed and audio frames are being written
   * to the WAV file), or after RECORDER_READY_MAX_WAIT_MS — whichever comes
   * first. Used by finishRecording() to avoid the fast-tap race described
   * in its docstring.
   *
   * If the ready signal already fired before this is called (the common
   * path on any hold > ~200 ms), resolves synchronously.
   */
  private waitForRecorderReady(child: ChildProcess): Promise<void> {
    if (this.recorderReady) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(() => {
        debug("recorder ready timed out — proceeding with kill anyway");
        finish();
      }, RECORDER_READY_MAX_WAIT_MS);
      // `recorder ready` is detected by the same once("data") that
      // handleHoldStart wired up — but that's a one-shot listener that
      // already fired or hasn't. Layer a second listener here that lasts
      // only for the duration of this finish. Also guard against the
      // recorder dying before it can say `ready` (no data, just exit).
      child.stdout?.once("data", () => {
        clearTimeout(timer);
        finish();
      });
      child.once("exit", () => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  /**
   * Deliver the transcript to wherever the user's cursor is. Primary path:
   * a direct AX insertion at the caret of the focused element (#102) — no
   * clipboard round-trip, no synthetic Cmd+V, the text simply appears where
   * the user is typing. This is what works for native AppKit text fields.
   *
   * If the focused element refuses an inline insert (no text field in focus,
   * or a Chromium / Electron contenteditable that won't accept
   * kAXSelectedText), fall back to the focus-aware Cmd+V paste, which in turn
   * degrades to clipboard-only (#90). The clipboard was already populated by
   * the caller, so the user always has a manual paste as the last resort.
   */
  private async deliverText(text: string): Promise<void> {
    // Diagnostic: where is keyboard focus right now? Synthetic typing lands in
    // whatever app is frontmost, so logging it tells us whether the transcript
    // is going to the user's target field or somewhere else (e.g. Marshal
    // grabbing frontmost). probeFocusedElement reads frontmost reliably here;
    // its AX role is usually blind (-25204) on self-signed helpers — expected.
    const focus = await probeFocusedElement();
    debug(
      "deliverText → frontmost=", focus.frontmostApp || "?",
      "(role=", focus.role || "?", "axError=", focus.axError, ")"
    );

    const typed = await insertTextIntoFocused(text);
    if (typed) {
      debug("typed transcript into frontmost focused field");
      return;
    }
    debug("typing failed — falling back to clipboard / Cmd+V");
    await this.maybeAutoPaste();
  }

  private async maybeAutoPaste(): Promise<void> {
    const focus = await probeFocusedElement();
    const shouldPaste = decideAutoPaste(focus);
    if (!shouldPaste) {
      debug(
        "clipboard only — role=", focus.role || "?",
        "axError=", focus.axError,
        "frontmost=", focus.frontmostApp || "?"
      );
      return;
    }
    if (isAxBlind(focus)) {
      debug(
        "AX silent on target — fail-open paste (frontmost=", focus.frontmostApp || "?",
        "axError=", focus.axError,
        "axTrusted=", focus.axTrusted,
        ")"
      );
    } else {
      debug("focused element accepts text — auto-pasting (role=", focus.role, ")");
    }
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
      // Wait for the recorder to report ready before sending SIGTERM. On a
      // fast tap the user releases the key before AVCaptureSession finishes
      // its handshake; killing then closes the WAV file after only the
      // 44-byte header is written, and the user sees a misleading "Audio
      // file is empty / microphone denied" error. Waiting up to
      // RECORDER_READY_MAX_WAIT_MS guarantees at least a few frames land
      // before we tear the recorder down. If `ready` never arrives (recorder
      // crashed before stdout flush) we proceed anyway so the loop doesn't
      // wedge. Issue: fast-tap race after #82.
      await this.waitForRecorderReady(child);

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
      // Collapse whisper repeat loops before either the clipboard or the
      // synthetic paste sees the text (#99). Keep the original on `result`
      // so the `transcribed` event reflects what the model actually emitted,
      // not the post-processed version — listeners that telemeter accuracy
      // need the raw output.
      const cleanText = collapseRepeats(result.text);
      if (cleanText.length > 0) {
        // Always populate the clipboard first as the dependable fallback the
        // user can paste by hand (#102). deliverText() then tries the primary
        // path — a direct AX insert at the caret — and only synthesises Cmd+V
        // if that's declined. Both paths are best-effort: worst case the text
        // is still sitting on the clipboard.
        clipboard.writeText(cleanText);
        await this.deliverText(cleanText);
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
