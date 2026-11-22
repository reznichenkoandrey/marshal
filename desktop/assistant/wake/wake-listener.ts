// Hands-free wake phrase (#274): «Маршал, …» starts a voice command without a key.
//
// The Swift helper (`wake-listener.swift`) holds the mic and runs a small
// sherpa-onnx keyword spotter. The spotter is a high-recall gate: it also fires
// on «маршрут» or "martial". Each candidate is cut into a clip (2.5 s before the
// spot plus whatever follows, until a pause), transcribed by the same whisper
// as dictation, and kept only when a sentence in it starts with the name.
//
// The sherpa runtime and the model (~38 MB) are downloaded on demand into the
// models dir, like Piper: nothing grows the app bundle.
//
// On macOS 26+ with Apple's Ukrainian dictation model the `apple` engine takes
// over (#432): `speech-wake.swift` transcribes every stretch of sound on device,
// so the name is found in text, not in a spotter, and the command comes back
// as text too: no clip, no whisper.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { modelsDir } from "../../dictation/model-installer.ts";
import { EndOfSpeech, endOfSpeechOptions, parseMeterLine } from "../../dictation/end-of-speech.ts";
import { installArchives, RELEASES, RUNTIME_DIR, SHERPA_VERSION, type InstallOptions, type PiperArchive } from "../../speech/piper.ts";
import { asarUnpacked } from "../../utils/asar-paths.ts";

const MODEL_DIR = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
const MODEL_FILES = ["encoder", "decoder", "joiner"].map((part) => `${part}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`);
// BPE pieces of MARSHAL in the gigaspeech vocabulary. "▁MAR" alone never fires on a clean
// "Marshal": the decoder goes on to SH instead of a blank (#421).
const KEYWORDS = "▁MAR SH AL @MARSHAL\n";
// After the name alone, this much quiet means "Маршал" was the whole utterance.
const NAME_PAUSE_MS = 1_500;
const DEBUG = process.env.MARSHAL_WAKE_DEBUG === "1";
const RESTART_DELAY_MS = 3_000;
// Dying sooner than this after a start is a crash loop (no mic, broken model): no restart.
const CRASH_LOOP_MS = 10_000;

function tempClip(): string {
  return path.join(os.tmpdir(), `marshal-wake-${process.pid}-${Date.now()}.wav`);
}

function removeClip(clip: string | null): void {
  if (clip) void fs.unlink(clip).catch(() => undefined);
}

function newEndOfSpeech(): EndOfSpeech {
  return new EndOfSpeech({ ...endOfSpeechOptions(), noSpeechMs: NAME_PAUSE_MS });
}

const HELPER_DIR = asarUnpacked(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_BIN = path.join(HELPER_DIR, "wake-listener");
const SPEECH_BIN = path.join(HELPER_DIR, "speech-wake");
const execFileAsync = promisify(execFile);

export type WakeEngine = "apple" | "sherpa";
type AppleSpeechStatus = "installed" | "supported" | "unsupported";

let appleStatus: Promise<AppleSpeechStatus> | null = null;

/** Whether macOS on-device dictation can serve the wake phrase in Ukrainian; asked once per run. */
function appleSpeechStatus(refresh = false): Promise<AppleSpeechStatus> {
  if (refresh || !appleStatus) {
    appleStatus = execFileAsync(SPEECH_BIN, ["--status"], { timeout: 15_000 })
      .then(({ stdout }) => {
        const status = stdout.trim().replace(/^status /, "");
        return status === "installed" || status === "supported" ? status : "unsupported";
      })
      .catch(() => "unsupported" as const);
  }
  return appleStatus;
}

/** `apple` wherever macOS 26 has the Ukrainian dictation model on offer; MARSHAL_WAKE_ENGINE=sherpa forces the spotter. */
export async function wakeEngine(): Promise<WakeEngine> {
  if (process.env.MARSHAL_WAKE_ENGINE === "sherpa") return "sherpa";
  return (await appleSpeechStatus()) === "unsupported" ? "sherpa" : "apple";
}

export async function isWakeReady(): Promise<boolean> {
  return (await wakeEngine()) === "apple" ? (await appleSpeechStatus()) === "installed" : isWakeInstalled();
}

export const WAKE_ARCHIVES: readonly PiperArchive[] = [
  {
    url: `${RELEASES}/${SHERPA_VERSION}/${RUNTIME_DIR}.tar.bz2`,
    bytes: 20_314_448,
    members: [`${RUNTIME_DIR}/lib`]
  },
  {
    url: `${RELEASES}/kws-models/${MODEL_DIR}.tar.bz2`,
    bytes: 17_626_723,
    members: [...MODEL_FILES, "tokens.txt"].map((file) => `${MODEL_DIR}/${file}`)
  }
];

export const WAKE_DOWNLOAD_BYTES = WAKE_ARCHIVES.reduce((sum, archive) => sum + archive.bytes, 0);

export type WakePaths = { lib: string; model: string; keywords: string };

export function wakeDir(): string {
  return path.join(modelsDir(), "wake");
}

export function wakePaths(root = wakeDir()): WakePaths {
  return {
    lib: path.join(root, RUNTIME_DIR, "lib"),
    model: path.join(root, MODEL_DIR),
    keywords: path.join(root, "keywords.txt")
  };
}

export function isWakeInstalled(paths = wakePaths()): boolean {
  return (
    existsSync(path.join(paths.lib, "libsherpa-onnx-c-api.dylib")) &&
    [...MODEL_FILES, "tokens.txt"].every((file) => existsSync(path.join(paths.model, file)))
  );
}

export async function installWake(options: InstallOptions = {}): Promise<void> {
  if ((await wakeEngine()) === "apple") {
    // Apple downloads the model itself; it is shared with system dictation.
    await execFileAsync(SPEECH_BIN, ["--install"], { timeout: 600_000 });
    if ((await appleSpeechStatus(true)) !== "installed") throw new Error("macOS did not install the Ukrainian speech model.");
    return;
  }
  const root = wakeDir();
  await installArchives(root, WAKE_ARCHIVES, options);
  if (!isWakeInstalled()) throw new Error(`Wake phrase files unpacked into ${root}, but some are missing.`);
}

// «Маршал» as whisper spells it, optionally after "гей / слухай / hey"; only at the start of a sentence.
const WAKE_PATTERN =
  /(?:^|[.!?…]\s+)(?:(?:гей|агов|слухай|hey|ok|окей|listen)[\s,]+)?(?:маршал(?:л|е|а|у)?|marshall?)(?![\p{L}\p{N}])[\s,.!?:;—–-]*/iu;

/**
 * What follows the name in a transcribed clip: "" for the name alone, null
 * when no sentence starts with it («поїхали на маршрут», "скажи marshal…").
 * The clip begins up to 2.5 s before the name, so earlier speech may precede it.
 */
export function wakeCommand(transcript: string): string | null {
  const match = WAKE_PATTERN.exec(transcript.trim());
  if (!match) return null;
  return transcript.trim().slice(match.index + match[0].length).trim();
}

export type WakeListenerDeps = {
  transcribe: (wavPath: string) => Promise<string>;
  /** False on a call, while a meeting recording or captions run: the name is not meant for Marshal then. */
  allowed: () => Promise<boolean>;
  onCommand: (text: string) => void;
  onNameOnly: () => void;
  /** Drives the assistant state: hearing the command, then transcribing it. */
  onPhase: (phase: { dictating: boolean; transcribing: boolean }) => void;
  /**
   * Speaker check (#287): asked about every candidate that is a command, with the candidate's
   * clip (null when the helper kept no audio). False drops the command without a word.
   */
  speaker?: { enabled: () => boolean; verify: (clip: string | null) => Promise<boolean> };
  /** `sherpa` when omitted. */
  engine?: WakeEngine;
  binPath?: string;
  paths?: WakePaths;
};

export class WakeListener {
  private child: ChildProcess | null = null;
  private endOfSpeech: EndOfSpeech | null = null;
  // The spot fires while the name is still being said; its tail is not the command (#427).
  private nameTail = false;
  // From the spot until the clip is handled; one candidate at a time.
  private capturing = false;
  private busy = false;
  private stopped = false;
  // apple engine: the held stretch's text and the last sign the owner is still talking (#433).
  private heldText = "";
  private heldAt = 0;
  private activityAt = 0;
  // After the name alone: the next thing said is the command, no name needed (#433).
  private followUpUntil = 0;
  private followUp = false;
  // apple engine: where the helper writes the held stretch's audio for the speaker check (#287).
  private clipPath: string | null = null;

  constructor(private readonly deps: WakeListenerDeps) {}

  isRunning(): boolean {
    return this.child !== null;
  }

  start(): void {
    this.stopped = false;
    if (this.child) return;
    const apple = this.deps.engine === "apple";
    const paths = this.deps.paths ?? wakePaths();
    const bin = this.deps.binPath ?? (apple ? SPEECH_BIN : DEFAULT_BIN);
    if (!existsSync(bin)) {
      console.warn(`[wake] helper missing at ${bin}; run npm run build`);
      return;
    }
    if (!apple) writeFileSync(paths.keywords, KEYWORDS);
    // ponytail: the AudioQueue binds to the default input at start; a new default mic needs a restart (toggle in Settings).
    const args = apple ? [] : ["--lib", paths.lib, "--model", paths.model, "--keywords", paths.keywords];
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"] });
    this.child = child;
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    child.on("error", (err) => console.warn("[wake] helper failed:", err.message));
    const startedAt = Date.now();
    child.on("exit", (code, signal) => {
      // stop() clears child first: only a helper that died on its own is still current.
      const died = this.child === child;
      if (died) this.child = null;
      this.endCapture();
      if (!died) return;
      console.warn(`[wake] helper exited (code ${code}, signal ${signal})`);
      // A dead helper used to leave the wake phrase off until Marshal restarted (#429).
      if (Date.now() - startedAt < CRASH_LOOP_MS) return;
      setTimeout(() => {
        if (!this.child && !this.stopped) this.start();
      }, RESTART_DELAY_MS).unref();
    });
    if (this.busy) this.send("pause");
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    // EOF on stdin stops the helper; SIGTERM covers a wedged one.
    child?.stdin?.end();
    child?.kill("SIGTERM");
    this.endCapture();
  }

  /**
   * apple engine: whatever is said in the next `ms` is the command. Answering «Слухаю.» used to go
   * through the dictation recorder, whose energy gate dropped a quiet voice as "nobody answered".
   */
  listenForCommand(ms: number): void {
    // The command is already being heard; arming now would turn the next room talk into one.
    if (this.capturing) return;
    this.followUpUntil = Date.now() + ms;
  }

  /** Marshal speaks, dictation records or transcribes: the mic hears Marshal or a command already, not a wake phrase. */
  setBusy(busy: boolean): void {
    if (busy === this.busy) return;
    this.busy = busy;
    // A capture under way is the owner talking to us; it finishes first.
    if (!this.capturing) this.send(busy ? "pause" : "resume");
  }

  private send(command: string): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${command}\n`);
  }

  private onLine(line: string): void {
    if (line === "wake") {
      if (DEBUG) console.log(`[wake] candidate${this.capturing ? " (already capturing)" : ""}`);
      this.beginCapture();
      return;
    }
    if (line.startsWith("partial ")) {
      const text = line.slice("partial ".length);
      if (this.capturing) {
        if (this.heldAt && text !== this.heldText) {
          this.heldText = text;
          this.activityAt = Date.now();
        }
        return;
      }
      // The apple helper's running text: the name at the start of a sentence holds the stretch open.
      const followUp = Date.now() < this.followUpUntil && text.trim() !== "";
      if (!followUp && wakeCommand(text) === null) return;
      if (DEBUG) console.log(`[wake] ${followUp ? "follow-up" : "candidate"} ${JSON.stringify(text)}`);
      this.followUpUntil = 0;
      this.followUp = followUp;
      this.beginCapture();
      this.heldText = text;
      this.heldAt = this.activityAt = Date.now();
      this.clipPath = this.deps.speaker?.enabled() ? tempClip() : null;
      this.send(this.clipPath ? `hold ${this.clipPath}` : "hold");
      return;
    }
    if (line === "final" || line.startsWith("final ")) {
      const text = line.slice("final".length).trim();
      const clip = this.clipPath;
      this.clipPath = null;
      if (this.capturing) void this.handleCandidate(async () => text, this.followUp, clip).finally(() => removeClip(clip));
      else removeClip(clip);
      return;
    }
    const db = parseMeterLine(line);
    if (db !== null && this.deps.engine === "apple") {
      if (this.heldAt && this.heldEnded(db, Date.now())) {
        if (DEBUG) console.log(`[wake] end ${JSON.stringify(this.heldText)}`);
        this.heldAt = 0;
        this.send(this.clipPath ? `end ${this.clipPath}` : "end");
      }
      return;
    }
    if (db !== null) {
      // Restart at the first quiet reading: the pause after «Маршал,» then gets NAME_PAUSE_MS,
      // instead of the 0.9 s that ends a command and cut the clip before it began.
      if (this.nameTail && this.endOfSpeech && db < endOfSpeechOptions().speechDb) {
        this.nameTail = false;
        this.endOfSpeech = newEndOfSpeech();
      }
      if (this.endOfSpeech?.feed(db, Date.now())) {
        this.endOfSpeech = null;
        this.send(`end ${tempClip()}`);
      }
      return;
    }
    if (line.startsWith("clip ")) {
      const wavPath = line.slice("clip ".length);
      void this.handleCandidate(() => this.deps.transcribe(wavPath), false, wavPath).finally(() => removeClip(wavPath));
      return;
    }
    if (line.startsWith("error ")) console.warn(`[wake] ${line}`);
  }

  /**
   * Energy alone cut the command off: a quiet voice reads below speechDb, and the name's
   * partial lands after the name is over (#433). New text counts as talking too.
   */
  private heldEnded(db: number, now: number): boolean {
    const { speechDb, silenceMs, maxMs } = endOfSpeechOptions();
    if (db >= speechDb) this.activityAt = now;
    if (now - this.heldAt >= maxMs) return true;
    const quietMs = this.followUp || wakeCommand(this.heldText) ? silenceMs : NAME_PAUSE_MS;
    return now - this.activityAt >= quietMs;
  }

  private beginCapture(): void {
    if (this.capturing) return;
    this.capturing = true;
    this.nameTail = true;
    this.endOfSpeech = newEndOfSpeech();
    this.deps.onPhase({ dictating: true, transcribing: false });
  }

  private async handleCandidate(transcribe: () => Promise<string>, followUp = false, clip: string | null = null): Promise<void> {
    this.deps.onPhase({ dictating: false, transcribing: true });
    let command: string | null = null;
    try {
      if (!(await this.deps.allowed())) {
        if (DEBUG) console.log("[wake] candidate dropped: open mic not allowed (call, recording, captions)");
        return;
      }
      const transcript = await transcribe();
      // A follow-up may repeat the name; an empty one is dropped, not answered with another «Слухаю.».
      command = followUp ? wakeCommand(transcript) || transcript.trim() || null : wakeCommand(transcript);
      if (DEBUG) console.log(`[wake] heard ${JSON.stringify(transcript)} → ${JSON.stringify(command)}`);
      // The name alone counts too: a voice that is not the owner's gets no «Слухаю.».
      if (command !== null && this.deps.speaker?.enabled() && !(await this.deps.speaker.verify(clip))) command = null;
    } catch (err) {
      console.warn("[wake] candidate failed:", err instanceof Error ? err.message : String(err));
    } finally {
      this.endCapture();
    }
    // After endCapture: onNameOnly arms the follow-up window, which a capture under way refuses.
    if (command === "") this.deps.onNameOnly();
    else if (command !== null) this.deps.onCommand(command);
  }


  private endCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.nameTail = false;
    this.endOfSpeech = null;
    this.heldAt = 0;
    this.followUp = false;
    removeClip(this.clipPath);
    this.clipPath = null;
    this.deps.onPhase({ dictating: false, transcribing: false });
    if (this.busy) this.send("pause");
  }
}
