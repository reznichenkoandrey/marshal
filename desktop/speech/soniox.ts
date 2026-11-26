// Soniox cloud TTS for Ukrainian spoken updates (#515): tts-rt-v2 over one
// WebSocket, raw PCM streamed to playback chunk by chunk. The socket opens on
// the first phrase (or warmUp) and closes after SONIOX_WARM_MS without a phrase,
// so nothing stays open while Marshal is silent (#281).

import { DEFAULT_SPEECH_RATE, normalizeSpeechRate } from "./speech-policy.ts";

export const SONIOX_WS_URL = "wss://tts-rt.soniox.com/tts-websocket";
export const SONIOX_MODEL = "tts-rt-v2";
export const SONIOX_VOICE = "Adrian";
export const SONIOX_SAMPLE_RATE = 24_000;
export const SONIOX_VOICE_LABEL = `Soniox · ${SONIOX_VOICE}`;
// Below the server's ~40 s idle close, so no keep_alive timer is needed.
export const SONIOX_WARM_MS = 30_000;
// Measured first audio 0.4–0.7 s on a warm socket; a cold handshake adds a few hundred ms.
const FIRST_AUDIO_TIMEOUT_MS = 6_000;
const STALL_TIMEOUT_MS = 10_000;
const SPEED_MIN = 0.7;
const SPEED_MAX = 1.3;

export function sonioxApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.SONIOX_API_KEY?.trim();
  return key ? key : null;
}

/** `say -r` words per minute → Soniox speed, clamped to the API's 0.7–1.3. */
export function sonioxSpeedForRate(rate: unknown): number {
  const speed = normalizeSpeechRate(rate) / DEFAULT_SPEECH_RATE;
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed)) * 100) / 100;
}

export function buildSonioxConfig(streamId: string, speed: number): Record<string, unknown> {
  return {
    stream_id: streamId,
    model: SONIOX_MODEL,
    language: "uk",
    voice: SONIOX_VOICE,
    audio_format: "pcm_s16le",
    sample_rate: SONIOX_SAMPLE_RATE,
    speed
  };
}

export type SonioxEvent =
  | { kind: "audio"; streamId: string; audio: Buffer }
  | { kind: "error"; streamId: string | null; message: string }
  | { kind: "terminated"; streamId: string }
  | { kind: "ignore" };

/** One server frame → what the client acts on. Never throws: a bad frame is ignored. */
export function parseSonioxMessage(raw: string): SonioxEvent {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "ignore" };
  }
  if (!data || typeof data !== "object") return { kind: "ignore" };
  const frame = data as Record<string, unknown>;
  const streamId = typeof frame.stream_id === "string" ? frame.stream_id : null;
  if (frame.error_code !== undefined || frame.error_type !== undefined) {
    const code = frame.error_code ?? "?";
    const type = typeof frame.error_type === "string" ? frame.error_type : "error";
    const text = typeof frame.error_message === "string" ? frame.error_message : "";
    return { kind: "error", streamId, message: `Soniox ${code} ${type}${text ? `: ${text}` : ""}` };
  }
  if (!streamId) return { kind: "ignore" };
  if (typeof frame.audio === "string" && frame.audio) {
    return { kind: "audio", streamId, audio: Buffer.from(frame.audio, "base64") };
  }
  if (frame.terminated === true) return { kind: "terminated", streamId };
  return { kind: "ignore" };
}

type Stream = {
  onAudio: (pcm: Buffer) => void;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
};

export type SonioxPhrase = {
  /** Resolves when the last audio chunk arrived; rejects before or during the stream. */
  done: Promise<void>;
  /** Stops generating; `done` resolves. */
  cancel: () => void;
};

export type SocketFactory = (url: string, key: string) => WebSocket;

// The key rides in the subprotocol list (documented by Soniox, checked 2026-11-25): the
// standard WebSocket constructor has no headers.
const defaultSocket: SocketFactory = (url, key) => new WebSocket(url, ["soniox-api-key", key]);

/**
 * Splits a phrase into sentences so the first one plays while the rest synthesize: Soniox audio
 * only plays once its stream is complete, and a two-sentence answer waited ~4.5 s (live check 2026-11-26).
 */
export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?…]+(?:[.!?…]+|$)/gu) ?? [])
    .map((part) => part.trim())
    .filter((part) => /[\p{L}\p{N}]/u.test(part));
}

export class SonioxTts {
  private socket: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private readonly streams = new Map<string, Stream>();
  private closeTimer: NodeJS.Timeout | null = null;
  private counter = 0;

  constructor(
    private readonly apiKey: () => string | null = () => sonioxApiKey(),
    private readonly createSocket: SocketFactory = defaultSocket
  ) {}

  /** A phrase is on its way: open the socket now, not when it arrives. */
  warmUp(): void {
    if (!this.apiKey()) return;
    this.connect().then(
      () => this.scheduleClose(),
      (err: unknown) => console.warn("[speech] soniox warm-up failed:", err instanceof Error ? err.message : err)
    );
  }

  speak(text: string, speed: number, onAudio: (pcm: Buffer) => void): SonioxPhrase {
    const streamId = `marshal-${process.pid}-${++this.counter}`;
    let stream: Stream | undefined;
    const done = new Promise<void>((resolve, reject) => {
      stream = { onAudio, resolve, reject, timer: null };
    });
    const entry = stream as Stream;
    this.streams.set(streamId, entry);
    this.clearCloseTimer();
    this.arm(streamId, FIRST_AUDIO_TIMEOUT_MS);
    this.connect().then(
      (socket) => {
        if (!this.streams.has(streamId)) return;
        socket.send(JSON.stringify(buildSonioxConfig(streamId, speed)));
        socket.send(JSON.stringify({ stream_id: streamId, text, text_end: true }));
      },
      (err: unknown) => this.finish(streamId, err instanceof Error ? err : new Error(String(err)))
    );
    const cancel = (): void => {
      if (!this.streams.has(streamId)) return;
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ stream_id: streamId, cancel: true }));
      }
      this.finish(streamId);
    };
    return { done, cancel };
  }

  close(): void {
    this.clearCloseTimer();
    const socket = this.socket;
    this.socket = null;
    this.opening = null;
    this.failAll(new Error("Soniox connection closed."));
    socket?.close();
  }

  private connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    const key = this.apiKey();
    if (!key) return Promise.reject(new Error("SONIOX_API_KEY is not set."));
    const opening = new Promise<WebSocket>((resolve, reject) => {
      const socket = this.createSocket(SONIOX_WS_URL, key);
      socket.addEventListener("open", () => {
        if (this.opening !== opening) {
          socket.close();
          return;
        }
        this.socket = socket;
        this.opening = null;
        resolve(socket);
      });
      socket.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data === "string") this.onMessage(event.data);
      });
      // No message on purpose: the event carries nothing useful and the close follows.
      socket.addEventListener("error", () => reject(new Error("Soniox connection failed.")));
      socket.addEventListener("close", (event: CloseEvent) => {
        reject(new Error(`Soniox connection closed (${event.code}).`));
        if (this.socket !== socket && this.opening !== opening) return;
        this.socket = null;
        this.opening = null;
        this.clearCloseTimer();
        this.failAll(new Error(`Soniox connection closed (${event.code}).`));
      });
    });
    this.opening = opening;
    return opening;
  }

  private onMessage(raw: string): void {
    const event = parseSonioxMessage(raw);
    if (event.kind === "ignore") return;
    if (event.kind === "error") {
      // A connection-level error (no stream id) fails every phrase on it.
      if (event.streamId) this.finish(event.streamId, new Error(event.message));
      else this.failAll(new Error(event.message));
      return;
    }
    const stream = this.streams.get(event.streamId);
    if (!stream) return;
    if (event.kind === "terminated") {
      this.finish(event.streamId);
      return;
    }
    this.arm(event.streamId, STALL_TIMEOUT_MS);
    stream.onAudio(event.audio);
  }

  private arm(streamId: string, ms: number): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = setTimeout(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ stream_id: streamId, cancel: true }));
      }
      this.finish(streamId, new Error(`Soniox timed out after ${ms} ms.`));
    }, ms);
  }

  private finish(streamId: string, error?: Error): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.streams.delete(streamId);
    if (stream.timer) clearTimeout(stream.timer);
    if (error) stream.reject(error);
    else stream.resolve();
    this.scheduleClose();
  }

  private failAll(error: Error): void {
    for (const id of [...this.streams.keys()]) this.finish(id, error);
  }

  private scheduleClose(): void {
    if (this.streams.size > 0 || (!this.socket && !this.opening)) return;
    this.clearCloseTimer();
    this.closeTimer = setTimeout(() => this.close(), SONIOX_WARM_MS);
    this.closeTimer.unref?.();
  }

  private clearCloseTimer(): void {
    if (!this.closeTimer) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }
}
