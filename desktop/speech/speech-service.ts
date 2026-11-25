import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  NO_EN_VOICE_MESSAGE,
  NO_UK_VOICE_MESSAGE,
  SpeechQueue,
  chooseSpeechEngine,
  detectSpeechLang,
  normalizeSpeechRate,
  parseSayVoices,
  pickVoice,
  pronounceForUkrainian,
  voicesForLang,
  type SpeechEngine,
  type SpeechItem,
  type SpeechLang,
  type SystemVoice
} from "./speech-policy.ts";
import { PIPER_VOICE_LABEL, buildPiperArgs, isPiperInstalled, piperPaths } from "./piper.ts";
import { markVoice } from "../assistant/voice-timing.ts";
import { HolosServer, isHolosInstalled, listHolosVoices, type HolosVoices } from "./holos.ts";
import { SONIOX_PLAYER_ARGS, SONIOX_VOICE_LABEL, SonioxTts, sonioxApiKey, sonioxSpeedForRate } from "./soniox.ts";
import { MeetingAudioMixer } from "../meeting/audio-mixer.ts";

const SAY_PATH = "/usr/bin/say";
const AFPLAY_PATH = "/usr/bin/afplay";
// The cue for "heard you, thinking" (#507): a stock macOS sound, quiet, no asset of our own.
const CUE_SOUND = "/System/Library/Sounds/Tink.aiff";
const CUE_VOLUME = "0.5";
// How often a pending or playing phrase re-checks the "must stay silent"
// signals. Push-to-talk calls interrupt() directly; this catches the rest.
const GATE_POLL_MS = 250;

export type SpeechSettings = {
  enabled: boolean;
  engine: SpeechEngine;
  holosVoice: string;
  rate: number;
  voiceUk: string;
  voiceEn: string;
};

export type SpeakOptions = {
  /** Omit to detect from the text. */
  lang?: SpeechLang;
  /** One key per source (session); a newer unspoken phrase replaces the older. */
  key?: string;
  /** Speak even when spoken updates are off (the Settings test button). */
  force?: boolean;
};

export type SpeakResult =
  | { ok: true; lang: SpeechLang; voice: string }
  | { ok: false; lang?: SpeechLang; error: string };

export type SpeechVoiceReport = {
  available: boolean;
  uk: SystemVoice[];
  en: SystemVoice[];
  piperInstalled: boolean;
  holosInstalled: boolean;
  holosVoices: HolosVoices;
  sonioxConfigured: boolean;
};

/** The engine can speak now: downloaded, or for Soniox a key in `.env`. */
export function speechEngineReady(engine: SpeechEngine): boolean {
  if (engine === "piper") return isPiperInstalled();
  if (engine === "holos") return isHolosInstalled();
  if (engine === "soniox") return sonioxApiKey() !== null;
  return true;
}

/**
 * `voice` is the `say` voice; empty when only another engine can speak the
 * phrase (no fallback then). `sayText` is what `say` reads if that engine fails.
 */
type QueuedPhrase = SpeechItem & { voice: string; engine: SpeechEngine; sayText: string };

type Playback = {
  phrase: QueuedPhrase;
  child: ChildProcess | null;
  /** Stops work that is not a child process (a Soniox stream). */
  stop?: () => void;
  requeue: boolean;
  cut: boolean;
};

/**
 * Spoken updates (#266) through the native `say` voices — no model, no extra
 * memory. Never speaks while `blockedReason()` returns a reason (dictation,
 * captions, a call): a pending phrase waits, a playing one is cut and spoken
 * again from the start once the reason clears.
 */
function engineLabel(engine: SpeechEngine, holosVoice: string): string {
  if (engine === "holos") return `Holos · ${holosVoice || "default"}`;
  return engine === "soniox" ? SONIOX_VOICE_LABEL : PIPER_VOICE_LABEL;
}

export class SpeechService {
  private readonly queue = new SpeechQueue<QueuedPhrase>();
  private current: Playback | null = null;
  private wavCounter = 0;
  private voices: Promise<SystemVoice[]> | null = null;
  private gateTimer: NodeJS.Timeout | null = null;
  private readonly holos = new HolosServer();
  private readonly soniox = new SonioxTts();
  private readonly quietWaiters: Array<() => void> = [];

  constructor(
    private readonly settings: () => SpeechSettings,
    private readonly blockedReason: () => string | null,
    // The assistant home shows "speaking" from this (#308).
    private readonly onSpeakingChange: (speaking: boolean) => void = () => {},
    // Another app holds the mic (#359). Checked once per phrase, not polled.
    private readonly onCall: () => Promise<boolean> = async () => false
  ) {}

  isAvailable(): boolean {
    return process.platform === "darwin" && fs.existsSync(SAY_PATH);
  }

  /** Installed voices; `refresh` re-reads them (the user may have just downloaded one). */
  listVoices(refresh = false): Promise<SystemVoice[]> {
    if (!this.isAvailable()) return Promise.resolve([]);
    if (refresh || !this.voices) {
      this.voices = new Promise<SystemVoice[]>((resolve) => {
        execFile(SAY_PATH, ["-v", "?"], { timeout: 10_000 }, (err, stdout) => {
          if (err) console.warn("[speech] listing voices failed:", err.message);
          resolve(err ? [] : parseSayVoices(stdout));
        });
      });
    }
    return this.voices;
  }

  async describeVoices(): Promise<SpeechVoiceReport> {
    const voices = await this.listVoices(true);
    return {
      available: this.isAvailable(),
      uk: voicesForLang(voices, "uk"),
      en: voicesForLang(voices, "en"),
      piperInstalled: isPiperInstalled(),
      holosInstalled: isHolosInstalled(),
      holosVoices: listHolosVoices(),
      sonioxConfigured: sonioxApiKey() !== null
    };
  }

  async speak(text: string, options: SpeakOptions = {}): Promise<SpeakResult> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "Nothing to speak." };
    if (!this.isAvailable()) return { ok: false, error: "Spoken updates need macOS (`say` was not found)." };
    const settings = this.settings();
    if (!settings.enabled && !options.force) return { ok: false, error: "Spoken updates are off in Settings." };
    // Dropped, not held: a phrase spoken an hour later is stale, and the notification stays on screen.
    if (!options.force && (await this.onCall())) return { ok: false, error: "Silent on a call." };

    const lang = options.lang ?? detectSpeechLang(trimmed);
    const spoken = lang === "uk" ? pronounceForUkrainian(trimmed) : trimmed;
    const preferred = lang === "uk" ? settings.voiceUk : settings.voiceEn;
    let voice = pickVoice(await this.listVoices(), lang, preferred);
    // A voice installed after the first listing should work without a restart.
    voice ??= pickVoice(await this.listVoices(true), lang, preferred);
    const engine = chooseSpeechEngine(settings.engine, lang, speechEngineReady(settings.engine));
    if (engine !== "macos") {
      // Soniox says English terms right on its own; the rewrite made phrases longer and stilted (#515).
      const text = engine === "soniox" ? trimmed : spoken;
      this.queue.enqueue({ text, sayText: spoken, lang, key: options.key, voice: voice?.name ?? "", engine });
      this.pump();
      return { ok: true, lang, voice: engineLabel(engine, settings.holosVoice) };
    }
    if (!voice) return { ok: false, lang, error: lang === "uk" ? NO_UK_VOICE_MESSAGE : NO_EN_VOICE_MESSAGE };

    this.queue.enqueue({ text: spoken, sayText: spoken, lang, key: options.key, voice: voice.name, engine });
    this.pump();
    return { ok: true, lang, voice: voice.name };
  }

  /** A phrase with this key waits in the queue, not yet spoken. */
  /** A short sound when a voice command goes to a model (#507); none while anything plays or must stay silent. */
  cue(): void {
    if (!this.isAvailable() || !this.settings().enabled || this.current || this.blockedReason()) return;
    spawn(AFPLAY_PATH, ["-v", CUE_VOLUME, CUE_SOUND], { stdio: "ignore" }).on("error", (err) => {
      console.warn("[speech] cue failed:", err.message);
    });
  }

  isQueued(key: string): boolean {
    return this.queue.has(key);
  }

  /** Resolves once nothing is playing or queued: the moment to open the mic for an answer (#375). */
  whenQuiet(): Promise<void> {
    if (!this.current && this.queue.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.quietWaiters.push(resolve));
  }

  private settleQuiet(): void {
    for (const resolve of this.quietWaiters.splice(0)) resolve();
  }

  /** Drops the phrase being spoken and moves on to the next one. */
  skip(): void {
    this.cut(false);
  }

  /** Silence now and forget everything pending. */
  stop(): void {
    this.queue.clear();
    this.cut(false);
    this.stopGate();
    this.settleQuiet();
    this.holos.stop();
    this.soniox.close();
  }

  /** A spoken answer is on its way (a voice command was sent): load Holos or open Soniox now, not on the answer. */
  warmUp(): void {
    const { engine } = this.settings();
    if (engine === "holos") this.holos.warmUp();
    else if (engine === "soniox") this.soniox.warmUp();
  }

  /** Clones a Holos voice from a recording; resolves with the new voice name. */
  cloneHolosVoice(recording: string): Promise<string> {
    return this.holos.cloneVoice(recording);
  }

  /** Silence now; the cut phrase is spoken again from the start later. */
  interrupt(): void {
    this.cut(true);
  }

  private cut(requeue: boolean): void {
    if (!this.current) return;
    this.current.requeue = requeue;
    this.current.cut = true;
    this.current.stop?.();
    this.current.child?.kill();
  }

  private pump(): void {
    if (this.current) return;
    if (this.queue.size === 0) {
      this.stopGate();
      this.settleQuiet();
      return;
    }
    this.startGate();
    if (this.blockedReason()) return;
    const phrase = this.queue.take();
    if (!phrase) return;
    const entry: Playback = { phrase, child: null, requeue: false, cut: false };
    this.current = entry;
    this.onSpeakingChange(true);
    void this.play(entry).then((error) => {
      if (this.current !== entry) return;
      this.current = null;
      if (error) console.warn("[speech] playback failed:", error);
      if (entry.requeue) this.queue.requeue(phrase);
      this.pump();
      // After pump: the next queued phrase keeps "speaking" without a flicker to idle.
      if (!this.current) this.onSpeakingChange(false);
    });
  }

  /** Resolves with an error message, or undefined when spoken or cut. */
  private async play(entry: Playback): Promise<string | undefined> {
    const { phrase } = entry;
    const rate = normalizeSpeechRate(this.settings().rate);
    if (phrase.engine === "soniox") {
      const result = await this.playSoniox(entry, phrase.text, rate);
      if (entry.cut || !result.error) return undefined;
      // Half a phrase already played: repeating it on another voice would be worse than stopping.
      if (result.started) return result.error;
      console.warn("[speech] soniox failed, falling back to say:", result.error);
      if (!phrase.voice) return `soniox failed and no macOS voice is installed for this language.`;
    } else if (phrase.engine !== "macos") {
      const wav = path.join(os.tmpdir(), `marshal-speech-${process.pid}-${++this.wavCounter}.wav`);
      try {
        const synthError = await this.synthesize(entry, phrase, wav, rate);
        if (entry.cut) return undefined;
        if (!synthError) {
          markVoice("audio");
          return await this.run(entry, AFPLAY_PATH, [wav]);
        }
        console.warn(`[speech] ${phrase.engine} failed, falling back to say:`, synthError);
      } finally {
        await fs.promises.rm(wav, { force: true });
      }
      if (entry.cut) return undefined;
      if (!phrase.voice) return `${phrase.engine} failed and no macOS voice is installed for this language.`;
    }
    markVoice("audio");
    // stdin, not argv: text that starts with "-" would otherwise parse as a flag.
    return this.run(entry, SAY_PATH, ["-v", phrase.voice, "-r", String(rate)], phrase.sayText);
  }

  /** Streams Soniox PCM into ffmpeg's audiotoolbox output, so playback starts on the first chunk. */
  private playSoniox(entry: Playback, text: string, rate: number): Promise<{ error?: string; started: boolean }> {
    const ffmpeg = MeetingAudioMixer.getBinaryPath();
    if (!ffmpeg) return Promise.resolve({ error: "ffmpeg was not found for Soniox playback.", started: false });
    return new Promise((resolve) => {
      let started = false;
      let error: string | undefined;
      let stderr = "";
      const player = spawn(ffmpeg, SONIOX_PLAYER_ARGS, { stdio: ["pipe", "ignore", "pipe"] });
      entry.child = player;
      player.stdin.on("error", () => {});
      player.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const phrase = this.soniox.speak(text, sonioxSpeedForRate(rate), (pcm) => {
        if (!started) {
          started = true;
          markVoice("audio");
        }
        player.stdin.write(pcm);
      });
      // SIGKILL: ffmpeg traps SIGTERM but stays blocked reading stdin, so it would never exit.
      const silence = (): void => {
        player.kill("SIGKILL");
      };
      entry.stop = () => {
        phrase.cancel();
        silence();
      };
      phrase.done.then(
        () => player.stdin.end(),
        (err: unknown) => {
          error = err instanceof Error ? err.message : String(err);
          silence();
        }
      );
      let settled = false;
      const done = (playerError?: string): void => {
        if (settled) return;
        settled = true;
        entry.child = null;
        entry.stop = undefined;
        phrase.cancel();
        resolve({ error: error ?? playerError, started });
      };
      player.on("error", (err) => done(err.message));
      player.on("exit", (code, signal) =>
        done(code === 0 || signal ? undefined : stderr.trim().split("\n").pop() || `ffmpeg exit ${code}`)
      );
    });
  }

  private async synthesize(entry: Playback, phrase: QueuedPhrase, wav: string, rate: number): Promise<string | undefined> {
    if (phrase.engine === "piper") {
      const paths = piperPaths();
      return this.run(entry, paths.binary, buildPiperArgs(paths, phrase.text, wav, rate));
    }
    try {
      // Not killable mid-phrase: a cut entry just drops the result.
      await this.holos.synthesize(phrase.text, this.settings().holosVoice, rate, wav);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private run(entry: Playback, command: string, args: string[], stdinText?: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: [stdinText === undefined ? "ignore" : "pipe", "ignore", "pipe"] });
      entry.child = child;
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      if (stdinText !== undefined) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(stdinText);
      }
      let settled = false;
      const done = (error?: string): void => {
        if (settled) return;
        settled = true;
        entry.child = null;
        resolve(error);
      };
      child.on("error", (err) => done(err.message));
      // sherpa-onnx prints its whole config first; the reason is the last line.
      child.on("exit", (code, signal) =>
        done(code === 0 || signal ? undefined : stderr.trim().split("\n").pop() || `exit ${code}`)
      );
    });
  }

  private startGate(): void {
    this.gateTimer ??= setInterval(() => {
      if (this.current && this.blockedReason()) this.interrupt();
      else if (!this.current) this.pump();
    }, GATE_POLL_MS);
  }

  private stopGate(): void {
    if (!this.gateTimer) return;
    clearInterval(this.gateTimer);
    this.gateTimer = null;
  }
}
