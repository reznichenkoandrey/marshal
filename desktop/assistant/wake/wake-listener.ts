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

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { modelsDir } from "../../dictation/model-installer.ts";
import { EndOfSpeech, endOfSpeechOptions, parseMeterLine } from "../../dictation/end-of-speech.ts";
import { installArchives, RELEASES, RUNTIME_DIR, SHERPA_VERSION, type InstallOptions, type PiperArchive } from "../../speech/piper.ts";
import { asarUnpacked } from "../../utils/asar-paths.ts";

const MODEL_DIR = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
const MODEL_FILES = ["encoder", "decoder", "joiner"].map((part) => `${part}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`);
// BPE pieces of MARSHAL in the gigaspeech vocabulary; checked against tokens.txt.
const KEYWORDS = "▁MAR SH AL @MARSHAL\n";
// After the name alone, this much quiet means "Маршал" was the whole utterance.
const NAME_PAUSE_MS = 1_500;

const DEFAULT_BIN = path.join(asarUnpacked(path.dirname(fileURLToPath(import.meta.url))), "wake-listener");

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
  binPath?: string;
  paths?: WakePaths;
};

export class WakeListener {
  private child: ChildProcess | null = null;
  private endOfSpeech: EndOfSpeech | null = null;
  // From the spot until the clip is handled; one candidate at a time.
  private capturing = false;
  private busy = false;

  constructor(private readonly deps: WakeListenerDeps) {}

  isRunning(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.child) return;
    const paths = this.deps.paths ?? wakePaths();
    const bin = this.deps.binPath ?? DEFAULT_BIN;
    if (!existsSync(bin)) {
      console.warn(`[wake] helper missing at ${bin}; run npm run build`);
      return;
    }
    writeFileSync(paths.keywords, KEYWORDS);
    // ponytail: the AudioQueue binds to the default input at start; a new default mic needs a restart (toggle in Settings).
    const child = spawn(bin, ["--lib", paths.lib, "--model", paths.model, "--keywords", paths.keywords], {
      stdio: ["pipe", "pipe", "inherit"]
    });
    this.child = child;
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    child.on("error", (err) => console.warn("[wake] helper failed:", err.message));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (code !== 0 && signal === null) console.warn(`[wake] helper exited with ${code}`);
      this.endCapture();
    });
    if (this.busy) this.send("pause");
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    // EOF on stdin stops the helper; SIGTERM covers a wedged one.
    child?.stdin?.end();
    child?.kill("SIGTERM");
    this.endCapture();
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
      if (this.capturing) return;
      this.capturing = true;
      this.endOfSpeech = new EndOfSpeech({ ...endOfSpeechOptions(), noSpeechMs: NAME_PAUSE_MS });
      this.deps.onPhase({ dictating: true, transcribing: false });
      return;
    }
    const db = parseMeterLine(line);
    if (db !== null) {
      if (this.endOfSpeech?.feed(db, Date.now())) {
        this.endOfSpeech = null;
        this.send(`end ${path.join(os.tmpdir(), `marshal-wake-${process.pid}-${Date.now()}.wav`)}`);
      }
      return;
    }
    if (line.startsWith("clip ")) {
      void this.handleClip(line.slice("clip ".length));
      return;
    }
    if (line.startsWith("error ")) console.warn(`[wake] ${line}`);
  }

  private async handleClip(wavPath: string): Promise<void> {
    this.deps.onPhase({ dictating: false, transcribing: true });
    try {
      if (!(await this.deps.allowed())) return;
      const transcript = await this.deps.transcribe(wavPath);
      const command = wakeCommand(transcript);
      if (process.env.MARSHAL_WAKE_DEBUG === "1") console.log(`[wake] heard ${JSON.stringify(transcript)} → ${JSON.stringify(command)}`);
      if (command === "") this.deps.onNameOnly();
      else if (command !== null) this.deps.onCommand(command);
    } catch (err) {
      console.warn("[wake] clip failed:", err instanceof Error ? err.message : String(err));
    } finally {
      await fs.unlink(wavPath).catch(() => undefined);
      this.endCapture();
    }
  }

  private endCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.endOfSpeech = null;
    this.deps.onPhase({ dictating: false, transcribing: false });
    if (this.busy) this.send("pause");
  }
}
