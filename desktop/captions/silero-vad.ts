// desktop/captions/silero-vad.ts
//
// Silero VAD (v5, ONNX) running in the main process through onnxruntime-web's
// WASM backend. Measured on this machine: real speech scores 0.98 mean,
// white noise / a 440 Hz tone / digital silence / keyboard-like bursts all
// score under 0.1, at 0.3–0.5 ms per 32 ms window. WebRTC VAD (libfvad) was
// tried first and rejected: it flags white noise and pure tones as speech,
// so over the energy gate it added nothing.
//
// Why onnxruntime-web and not onnxruntime-node: the node package is a
// native binding (300 MB unpacked, needs an Electron ABI rebuild); the web
// package runs the same model on WASM with no native code. Its wasm file is
// 14 MB and must live outside app.asar — see package.json asarUnpack.
//
// The model wants 512-sample windows (32 ms at 16 kHz) with 64 samples of
// context and carries an LSTM state between windows. The segmenter works in
// 20 ms frames and is synchronous, so this class keeps its own window
// buffer, runs inference in the background as windows fill, and answers
// `isSpeech` from the latest finished window — one to two windows behind the
// audio, which the segmenter's 240 ms pre-roll absorbs.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-web";

import { asarUnpacked } from "../utils/asar-paths.ts";

export interface SileroVadOptions {
  /** Probability above which a window becomes speech. */
  startThreshold: number;
  /** Probability below which speech ends — lower than start, so a wavering syllable does not flicker. */
  stopThreshold: number;
}

export const DEFAULT_SILERO_OPTIONS: SileroVadOptions = { startThreshold: 0.5, stopThreshold: 0.35 };

const SAMPLE_RATE = 16_000;
const WINDOW = 512;
const CONTEXT = 64;
const STATE_SHAPE: [number, number, number] = [2, 1, 128];

const currentFilePath = fileURLToPath(import.meta.url);
const MODEL_RELATIVE = path.join("assets", "models", "silero_vad.onnx");

/**
 * The model ships in `assets/models/`, next to the icons. This file runs from
 * `dist/desktop/captions/` (dev and packaged, where the root is app.asar) and
 * from `desktop/captions/` under vitest, so walk up until the asset appears
 * instead of hardcoding a depth. fs sees inside app.asar.
 */
function resolveModelPath(): string {
  let dir = path.dirname(currentFilePath);
  for (let i = 0; i < 5; i += 1) {
    const candidate = path.join(dir, MODEL_RELATIVE);
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(currentFilePath), "..", "..", "..", MODEL_RELATIVE);
}
const MODEL_PATH = resolveModelPath();

const localRequire = createRequire(import.meta.url);
let runtimeConfigured = false;

/**
 * Point the runtime at its wasm on disk. Inside app.asar the file is not
 * loadable by the runtime's own loader, so the package is asar-unpacked and
 * the path rewritten to the unpacked copy.
 */
function configureRuntime(): void {
  if (runtimeConfigured) return;
  runtimeConfigured = true;
  // The package's exports map hides package.json, so resolve the entry
  // point (dist/ort.node.min.js) and take its directory.
  const distDir = path.dirname(localRequire.resolve("onnxruntime-web"));
  ort.env.wasm.wasmPaths = `${asarUnpacked(distDir)}${path.sep}`;
  // One thread: worker threads would need the runtime's worker script
  // resolvable from the main process, and a 2 MB model does not need them.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = "error";
}

export class SileroVad {
  private readonly options: SileroVadOptions;
  private session: ort.InferenceSession | null = null;
  private state: Float32Array = new Float32Array(STATE_SHAPE[0] * STATE_SHAPE[1] * STATE_SHAPE[2]);
  private context: Float32Array = new Float32Array(CONTEXT);
  private pending: Float32Array = new Float32Array(WINDOW);
  private pendingLength = 0;
  private speaking = false;
  private lastProbability = 0;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  private constructor(options: SileroVadOptions) {
    this.options = options;
  }

  static async create(options: Partial<SileroVadOptions> = {}, modelPath = MODEL_PATH): Promise<SileroVad> {
    configureRuntime();
    const vad = new SileroVad({ ...DEFAULT_SILERO_OPTIONS, ...options });
    const model = readFileSync(modelPath);
    vad.session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ["wasm"] });
    return vad;
  }

  /** Probability of the most recent finished window, for diagnostics. */
  get probability(): number {
    return this.lastProbability;
  }

  /**
   * Feeds one 16 kHz Int16 frame and returns the current speech decision.
   * The decision reflects windows already scored; the frame itself is
   * scored asynchronously once enough samples have accumulated.
   */
  classify(frame: Int16Array): boolean {
    if (this.disposed) return false;
    let offset = 0;
    while (offset < frame.length) {
      const take = Math.min(WINDOW - this.pendingLength, frame.length - offset);
      for (let i = 0; i < take; i += 1) {
        this.pending[this.pendingLength + i] = frame[offset + i] / 32768;
      }
      this.pendingLength += take;
      offset += take;
      if (this.pendingLength === WINDOW) {
        const window = this.pending;
        this.pending = new Float32Array(WINDOW);
        this.pendingLength = 0;
        this.enqueue(window);
      }
    }
    return this.speaking;
  }

  /** Resolves once every queued window has been scored (tests, shutdown). */
  settle(): Promise<void> {
    return this.queue;
  }

  /** Forget the LSTM state and any partial window — call between utterances of different streams. */
  reset(): void {
    this.state = new Float32Array(this.state.length);
    this.context = new Float32Array(CONTEXT);
    this.pendingLength = 0;
    this.speaking = false;
    this.lastProbability = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const session = this.session;
    this.session = null;
    void this.queue.then(() => session?.release()).catch(() => undefined);
  }

  private enqueue(window: Float32Array): void {
    this.queue = this.queue
      .then(() => this.score(window))
      .catch((err: unknown) => {
        // A failed window keeps the previous decision; the next one retries.
        console.warn("[captions] silero inference failed:", err instanceof Error ? err.message : err);
      });
  }

  private async score(window: Float32Array): Promise<void> {
    const session = this.session;
    if (!session || this.disposed) return;
    const input = new Float32Array(CONTEXT + WINDOW);
    input.set(this.context, 0);
    input.set(window, CONTEXT);
    const result = await session.run({
      input: new ort.Tensor("float32", input, [1, CONTEXT + WINDOW]),
      state: new ort.Tensor("float32", this.state, STATE_SHAPE),
      sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), [])
    });
    if (this.disposed) return;
    // Copy out of the runtime's buffers: they are reused across runs.
    this.state = Float32Array.from(result.stateN.data as Float32Array);
    this.context = window.slice(WINDOW - CONTEXT);
    const probability = (result.output.data as Float32Array)[0];
    this.lastProbability = probability;
    if (this.speaking) {
      if (probability < this.options.stopThreshold) this.speaking = false;
    } else if (probability >= this.options.startThreshold) {
      this.speaking = true;
    }
  }
}
