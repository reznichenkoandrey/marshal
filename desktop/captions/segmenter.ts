// desktop/captions/segmenter.ts
//
// Energy-based voice activity segmentation for the live captions pipeline.
//
// The system audio tap delivers a continuous 16 kHz mono PCM stream. Whisper
// wants bounded clips, and latency wants them cut at the moment the speaker
// pauses — not on a fixed timer that slices words in half. This class turns
// the stream into utterances: it watches per-frame RMS energy against an
// adaptive noise floor, keeps a short pre-roll so the first syllable is not
// lost, and emits a segment once speech is followed by enough silence (or
// once a hard length cap is hit so a monologue still produces captions).
//
// Pure computation, no Electron / Node I/O — this is the part worth testing.

export interface SegmenterOptions {
  sampleRate: number;
  /** Analysis frame length. 20 ms is the usual VAD granularity. */
  frameMs: number;
  /** Absolute RMS floor (0–32767) below which a frame is never speech. */
  minSpeechRms: number;
  /** A frame is speech when its RMS exceeds the noise floor times this. */
  noiseFloorRatio: number;
  /** Audio kept from before the first speech frame. */
  prerollMs: number;
  /** Trailing silence that closes an utterance. */
  silenceEndMs: number;
  /** Utterances shorter than this are noise (a click, a notification). */
  minSpeechMs: number;
  /** Hard cap: a segment is emitted even if the speaker never pauses. */
  maxSegmentMs: number;
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  sampleRate: 16_000,
  frameMs: 20,
  minSpeechRms: 350,
  noiseFloorRatio: 2.5,
  prerollMs: 240,
  silenceEndMs: 650,
  minSpeechMs: 450,
  maxSegmentMs: 9_000
};

export interface SpeechSegment {
  samples: Int16Array;
  /** Speech duration inside the segment, excluding pre-roll and tail. */
  speechMs: number;
  /** Why the segment was cut. */
  reason: "silence" | "max-length" | "flush";
}

export type SegmentListener = (segment: SpeechSegment) => void;

export function frameRms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const sample = frame[i];
    sum += sample * sample;
  }
  return Math.sqrt(sum / frame.length);
}

export class SpeechSegmenter {
  private readonly options: SegmenterOptions;
  private readonly frameSamples: number;
  private readonly prerollFrames: number;
  private readonly silenceEndFrames: number;
  private readonly maxSegmentFrames: number;
  private readonly listener: SegmentListener;

  private pending = new Int16Array(0);
  private preroll: Int16Array[] = [];
  private active: Int16Array[] = [];
  private speechFrames = 0;
  private trailingSilenceFrames = 0;
  private inSpeech = false;
  /** Exponential estimate of the background level, in RMS units. */
  private noiseFloor: number;

  constructor(listener: SegmentListener, options: Partial<SegmenterOptions> = {}) {
    this.options = { ...DEFAULT_SEGMENTER_OPTIONS, ...options };
    this.listener = listener;
    this.frameSamples = Math.max(1, Math.round((this.options.sampleRate * this.options.frameMs) / 1000));
    this.prerollFrames = Math.ceil(this.options.prerollMs / this.options.frameMs);
    this.silenceEndFrames = Math.ceil(this.options.silenceEndMs / this.options.frameMs);
    this.maxSegmentFrames = Math.ceil(this.options.maxSegmentMs / this.options.frameMs);
    this.noiseFloor = this.options.minSpeechRms / this.options.noiseFloorRatio;
  }

  /** Current background estimate, exposed for diagnostics. */
  get currentNoiseFloor(): number {
    return this.noiseFloor;
  }

  get isInSpeech(): boolean {
    return this.inSpeech;
  }

  /** Feed raw little-endian 16-bit PCM bytes (any length, any alignment). */
  pushBytes(bytes: Uint8Array): void {
    // Keep a possible odd trailing byte for the next call — a chunk boundary
    // from a pipe can land in the middle of a sample.
    const combined = new Uint8Array(this.pendingBytes.length + bytes.length);
    combined.set(this.pendingBytes, 0);
    combined.set(bytes, this.pendingBytes.length);
    const usable = combined.length - (combined.length % 2);
    this.pendingBytes = combined.subarray(usable);
    if (usable === 0) return;
    const samples = new Int16Array(usable / 2);
    const view = new DataView(combined.buffer, combined.byteOffset, usable);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = view.getInt16(i * 2, true);
    }
    this.pushSamples(samples);
  }

  private pendingBytes = new Uint8Array(0);

  /** Feed PCM samples. Segments are delivered to the listener synchronously. */
  pushSamples(samples: Int16Array): void {
    const merged = new Int16Array(this.pending.length + samples.length);
    merged.set(this.pending, 0);
    merged.set(samples, this.pending.length);

    let offset = 0;
    while (offset + this.frameSamples <= merged.length) {
      this.processFrame(merged.subarray(offset, offset + this.frameSamples));
      offset += this.frameSamples;
    }
    this.pending = merged.slice(offset);
  }

  /** Emit whatever speech is buffered (used on stop). */
  flush(): void {
    if (this.inSpeech && this.speechFrames > 0) {
      this.emit("flush");
    }
    this.reset();
  }

  private processFrame(frame: Int16Array): void {
    const rms = frameRms(frame);
    const threshold = Math.max(this.options.minSpeechRms, this.noiseFloor * this.options.noiseFloorRatio);
    const isSpeech = rms > threshold;

    // Track the floor only on quiet frames, so speech never drags it up and
    // makes the detector deaf to the next sentence. Decay it slowly upward
    // during silence so a room that gets noisier is still followed.
    if (!isSpeech) {
      const alpha = rms < this.noiseFloor ? 0.2 : 0.02;
      this.noiseFloor = this.noiseFloor + alpha * (rms - this.noiseFloor);
    }

    if (!this.inSpeech) {
      if (isSpeech) {
        this.inSpeech = true;
        this.active = [...this.preroll, frame.slice()];
        this.preroll = [];
        this.speechFrames = 1;
        this.trailingSilenceFrames = 0;
      } else {
        this.preroll.push(frame.slice());
        if (this.preroll.length > this.prerollFrames) this.preroll.shift();
      }
      return;
    }

    this.active.push(frame.slice());
    if (isSpeech) {
      this.speechFrames += 1;
      this.trailingSilenceFrames = 0;
    } else {
      this.trailingSilenceFrames += 1;
    }

    if (this.trailingSilenceFrames >= this.silenceEndFrames) {
      const speechMs = this.speechFrames * this.options.frameMs;
      if (speechMs >= this.options.minSpeechMs) {
        this.emit("silence");
      }
      // Either way the utterance is over. The trailing silence becomes the
      // pre-roll of whatever comes next.
      this.preroll = this.active.slice(-this.prerollFrames);
      this.resetSpeechState();
      return;
    }

    if (this.active.length >= this.maxSegmentFrames) {
      this.emit("max-length");
      this.preroll = [];
      this.resetSpeechState();
    }
  }

  private emit(reason: SpeechSegment["reason"]): void {
    // Keep only part of the trailing silence so whisper still hears the
    // sentence end, without paying for the full pause.
    const keepSilence = Math.min(this.trailingSilenceFrames, Math.ceil(this.silenceEndFrames / 2));
    const dropFrames = reason === "silence" ? this.trailingSilenceFrames - keepSilence : 0;
    const frames = dropFrames > 0 ? this.active.slice(0, this.active.length - dropFrames) : this.active;
    const total = frames.reduce((sum, frame) => sum + frame.length, 0);
    const samples = new Int16Array(total);
    let offset = 0;
    for (const frame of frames) {
      samples.set(frame, offset);
      offset += frame.length;
    }
    this.listener({ samples, speechMs: this.speechFrames * this.options.frameMs, reason });
  }

  private resetSpeechState(): void {
    this.active = [];
    this.speechFrames = 0;
    this.trailingSilenceFrames = 0;
    this.inSpeech = false;
  }

  private reset(): void {
    this.resetSpeechState();
    this.preroll = [];
    this.pending = new Int16Array(0);
    this.pendingBytes = new Uint8Array(0);
  }
}
