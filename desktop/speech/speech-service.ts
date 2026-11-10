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
  voicesForLang,
  type SpeechEngine,
  type SpeechItem,
  type SpeechLang,
  type SystemVoice
} from "./speech-policy.ts";
import { PIPER_VOICE_LABEL, buildPiperArgs, isPiperInstalled, piperPaths } from "./piper.ts";

const SAY_PATH = "/usr/bin/say";
const AFPLAY_PATH = "/usr/bin/afplay";
// How often a pending or playing phrase re-checks the "must stay silent"
// signals. Push-to-talk calls interrupt() directly; this catches the rest.
const GATE_POLL_MS = 250;

export type SpeechSettings = {
  enabled: boolean;
  engine: SpeechEngine;
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
};

/** `voice` is the `say` voice; empty when only Piper can speak the phrase (no fallback then). */
type QueuedPhrase = SpeechItem & { voice: string; engine: SpeechEngine };

type Playback = { phrase: QueuedPhrase; child: ChildProcess | null; requeue: boolean; cut: boolean };

/**
 * Spoken updates (#266) through the native `say` voices — no model, no extra
 * memory. Never speaks while `blockedReason()` returns a reason (dictation,
 * captions, a call): a pending phrase waits, a playing one is cut and spoken
 * again from the start once the reason clears.
 */
export class SpeechService {
  private readonly queue = new SpeechQueue<QueuedPhrase>();
  private current: Playback | null = null;
  private wavCounter = 0;
  private voices: Promise<SystemVoice[]> | null = null;
  private gateTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly settings: () => SpeechSettings,
    private readonly blockedReason: () => string | null,
    // The assistant home shows "speaking" from this (#308).
    private readonly onSpeakingChange: (speaking: boolean) => void = () => {}
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
      piperInstalled: isPiperInstalled()
    };
  }

  async speak(text: string, options: SpeakOptions = {}): Promise<SpeakResult> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "Nothing to speak." };
    if (!this.isAvailable()) return { ok: false, error: "Spoken updates need macOS (`say` was not found)." };
    const settings = this.settings();
    if (!settings.enabled && !options.force) return { ok: false, error: "Spoken updates are off in Settings." };

    const lang = options.lang ?? detectSpeechLang(trimmed);
    const preferred = lang === "uk" ? settings.voiceUk : settings.voiceEn;
    let voice = pickVoice(await this.listVoices(), lang, preferred);
    // A voice installed after the first listing should work without a restart.
    voice ??= pickVoice(await this.listVoices(true), lang, preferred);
    const engine = chooseSpeechEngine(settings.engine, lang, isPiperInstalled());
    if (engine === "piper") {
      this.queue.enqueue({ text: trimmed, lang, key: options.key, voice: voice?.name ?? "", engine });
      this.pump();
      return { ok: true, lang, voice: PIPER_VOICE_LABEL };
    }
    if (!voice) return { ok: false, lang, error: lang === "uk" ? NO_UK_VOICE_MESSAGE : NO_EN_VOICE_MESSAGE };

    this.queue.enqueue({ text: trimmed, lang, key: options.key, voice: voice.name, engine });
    this.pump();
    return { ok: true, lang, voice: voice.name };
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
  }

  /** Silence now; the cut phrase is spoken again from the start later. */
  interrupt(): void {
    this.cut(true);
  }

  private cut(requeue: boolean): void {
    if (!this.current) return;
    this.current.requeue = requeue;
    this.current.cut = true;
    this.current.child?.kill();
  }

  private pump(): void {
    if (this.current) return;
    if (this.queue.size === 0) {
      this.stopGate();
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
    if (phrase.engine === "piper") {
      const wav = path.join(os.tmpdir(), `marshal-speech-${process.pid}-${++this.wavCounter}.wav`);
      try {
        const paths = piperPaths();
        const synthError = await this.run(entry, paths.binary, buildPiperArgs(paths, phrase.text, wav, rate));
        if (entry.cut) return undefined;
        if (!synthError) return await this.run(entry, AFPLAY_PATH, [wav]);
        console.warn("[speech] Piper failed, falling back to say:", synthError);
      } finally {
        await fs.promises.rm(wav, { force: true });
      }
      if (entry.cut) return undefined;
      if (!phrase.voice) return "Piper failed and no macOS voice is installed for this language.";
    }
    // stdin, not argv: text that starts with "-" would otherwise parse as a flag.
    return this.run(entry, SAY_PATH, ["-v", phrase.voice, "-r", String(rate)], phrase.text);
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
