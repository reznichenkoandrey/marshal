// Soniox real-time STT for assistant voice commands (#516): stt-rt-v6 over one
// WebSocket per command. The socket opens when the mic opens and the PCM is
// streamed while the owner speaks, so the text is final ~0.3 s after the key goes
// up. Dictation stays on whisper: Soniox normalises surzhyk, and dictation must
// be verbatim. Nothing is open between commands (#281).

import { sonioxApiKey } from "../speech/soniox.ts";
import type { DictationMode } from "./dictation-service.ts";

export const SONIOX_STT_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
export const SONIOX_STT_MODEL = "stt-rt-v6";
// After the end frame: past this, whisper on the WAV is faster than waiting.
export const SONIOX_FINISH_TIMEOUT_MS = 2_500;
// PCM held while the handshake is in flight: one minute of 16 kHz s16le.
const MAX_QUEUED_BYTES = 16_000 * 2 * 60;
const MAX_TERMS = 100;

/**
 * The Soniox key for this recording, or null for whisper: only assistant input
 * (talk key, home mic, an answer) and only when Settings chose Soniox.
 */
export function sonioxSttKey(mode: DictationMode, env: NodeJS.ProcessEnv = process.env): string | null {
  if (mode === "paste" || env.MARSHAL_ASSISTANT_STT !== "soniox") return null;
  return sonioxApiKey(env);
}

export function buildSonioxSttConfig(terms: readonly string[]): Record<string, unknown> {
  const unique = [...new Set(terms.map((term) => term.trim()).filter(Boolean))].slice(0, MAX_TERMS);
  return {
    model: SONIOX_STT_MODEL,
    audio_format: "pcm_s16le",
    sample_rate: 16_000,
    num_channels: 1,
    language_hints: ["uk", "en"],
    enable_language_identification: true,
    enable_endpoint_detection: true,
    ...(unique.length > 0 ? { context: { terms: unique } } : {})
  };
}

export type SttToken = { text: string; isFinal: boolean };

export type SttFrame =
  | { kind: "tokens"; tokens: SttToken[]; finished: boolean }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

/** One server frame → what the client acts on. Never throws: a bad frame is ignored. */
export function parseSttMessage(raw: string): SttFrame {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "ignore" };
  }
  if (!data || typeof data !== "object") return { kind: "ignore" };
  const frame = data as Record<string, unknown>;
  if (frame.error_code !== undefined || frame.error_message !== undefined) {
    const text = typeof frame.error_message === "string" ? `: ${frame.error_message}` : "";
    return { kind: "error", message: `Soniox ${String(frame.error_code ?? "?")}${text}` };
  }
  const tokens: SttToken[] = [];
  if (Array.isArray(frame.tokens)) {
    for (const token of frame.tokens) {
      if (!token || typeof token !== "object") continue;
      const { text, is_final } = token as Record<string, unknown>;
      if (typeof text === "string") tokens.push({ text, isFinal: is_final === true });
    }
  }
  const finished = frame.finished === true;
  return tokens.length > 0 || finished ? { kind: "tokens", tokens, finished } : { kind: "ignore" };
}

const ENDPOINT = "<end>";
const FINALIZE = "<fin>";

/**
 * Final tokens arrive once and accumulate; non-final ones are a guess that the
 * next frame replaces. `<end>` marks a pause the server took as the end of speech.
 */
export class SttTranscript {
  private final = "";
  private guess = "";
  endpoint = false;

  feed(tokens: readonly SttToken[]): void {
    let guess = "";
    for (const token of tokens) {
      if (token.text === ENDPOINT) {
        this.endpoint = true;
        continue;
      }
      if (token.text === FINALIZE) continue;
      if (token.isFinal) this.final += token.text;
      else guess += token.text;
    }
    this.guess = guess;
  }

  get text(): string {
    return (this.final + this.guess).replace(/\s+/g, " ").trim();
  }
}

export type SttSocketFactory = (url: string, key: string) => WebSocket;

// Undici's WebSocket takes headers in its init object; the DOM typings know only protocols.
type HeaderSocket = new (url: string, init: { headers: Record<string, string> }) => WebSocket;
const defaultSocket: SttSocketFactory = (url, key) =>
  new (WebSocket as unknown as HeaderSocket)(url, { headers: { Authorization: `Bearer ${key}` } });

/** One voice command: open on construction, `write` PCM, `finish` for the text. */
export class SonioxSttSession {
  readonly transcript = new SttTranscript();
  private readonly socket: WebSocket;
  private queue: Buffer[] = [];
  private queued = 0;
  private bytes = 0;
  private open = false;
  private ending = false;
  private finished = false;
  private failure: Error | null = null;
  private settle: { resolve: (text: string) => void; reject: (error: Error) => void } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    key: string,
    terms: readonly string[],
    private readonly onEndpoint: () => void = () => undefined,
    createSocket: SttSocketFactory = defaultSocket
  ) {
    this.socket = createSocket(SONIOX_STT_URL, key);
    this.socket.addEventListener("open", () => {
      this.open = true;
      this.socket.send(JSON.stringify(buildSonioxSttConfig(terms)));
      for (const chunk of this.queue) this.socket.send(chunk);
      this.queue = [];
      this.queued = 0;
      if (this.ending) this.socket.send("");
    });
    this.socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") this.onMessage(event.data);
    });
    // No message on purpose: the event carries nothing useful and the close follows.
    this.socket.addEventListener("error", () => this.fail(new Error("Soniox connection failed.")));
    this.socket.addEventListener("close", (event: CloseEvent) => {
      if (!this.finished) this.fail(new Error(`Soniox connection closed (${event.code}).`));
    });
  }

  write(pcm: Buffer): void {
    if (this.failure || this.ending) return;
    this.bytes += pcm.length;
    if (this.open) {
      this.socket.send(pcm);
      return;
    }
    if (this.queued + pcm.length > MAX_QUEUED_BYTES) {
      this.fail(new Error("Soniox did not connect in time."));
      return;
    }
    this.queue.push(pcm);
    this.queued += pcm.length;
  }

  /** Ends the audio and resolves with the final text; rejects on any failure. */
  finish(timeoutMs = SONIOX_FINISH_TIMEOUT_MS): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.finished) return Promise.resolve(this.transcript.text);
    // The recorder could not open its PCM tap: an empty answer would drop a command the WAV has.
    if (this.bytes === 0) {
      this.fail(new Error("Soniox got no audio from the recorder."));
      return Promise.reject(this.failure ?? new Error("Soniox got no audio from the recorder."));
    }
    const result = new Promise<string>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    if (!this.ending) {
      this.ending = true;
      // An empty text frame tells Soniox the audio is over.
      if (this.open) this.socket.send("");
    }
    this.timer = setTimeout(() => this.fail(new Error(`Soniox timed out after ${timeoutMs} ms.`)), timeoutMs);
    return result;
  }

  abort(): void {
    this.fail(new Error("Soniox session aborted."));
  }

  private onMessage(raw: string): void {
    const frame = parseSttMessage(raw);
    if (frame.kind === "ignore") return;
    if (frame.kind === "error") {
      this.fail(new Error(frame.message));
      return;
    }
    const hadEndpoint = this.transcript.endpoint;
    this.transcript.feed(frame.tokens);
    if (!hadEndpoint && this.transcript.endpoint) this.onEndpoint();
    if (!frame.finished) return;
    this.finished = true;
    this.clearTimer();
    this.settle?.resolve(this.transcript.text);
    this.settle = null;
    this.socket.close();
  }

  private fail(error: Error): void {
    if (this.failure || this.finished) return;
    this.failure = error;
    this.queue = [];
    this.clearTimer();
    this.settle?.reject(error);
    this.settle = null;
    if (this.socket.readyState === 0 || this.socket.readyState === 1) this.socket.close();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
