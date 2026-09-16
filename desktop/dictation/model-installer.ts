// desktop/dictation/model-installer.ts
//
// Whisper models are 0.5–3 GB, so they do not belong inside the .app — a
// packaged build carrying `ggml-large-v3-turbo.bin` was a 1.5 GB DMG of which
// the application itself was under 100 MB. The model now lives in a shared
// directory outside any app bundle:
//
//   ~/Library/Application Support/Marshal/models/ggml-large-v3-turbo.bin
//
// Deliberately NOT `app.getPath("userData")`: that resolves to .../Electron
// in dev and .../Marshal when packaged, which would mean two 1.5 GB copies.
// A fixed directory means one copy, shared by every build, surviving app
// reinstalls and updates. `MARSHAL_MODELS_DIR` overrides it.
//
// This module owns the model list, the download and the on-disk layout. It
// imports no Electron so the dictation backend and the tests can use it.

import { createWriteStream, existsSync, promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface WhisperModelSpec {
  /** File name on disk and in the upstream repository. */
  readonly name: string;
  /** What the upstream download script calls it. */
  readonly label: string;
  /** Exact size in bytes — used to verify a finished download and to resume. */
  readonly bytes: number;
  readonly note: string;
}

/**
 * Supported models in resolution priority: turbo first (the default since
 * #93), then large-v3 for anyone who wants maximum accuracy, then small for
 * installs that predate #93. Sizes are the upstream Content-Length values.
 */
export const WHISPER_MODELS: readonly WhisperModelSpec[] = [
  {
    name: "ggml-large-v3-turbo.bin",
    label: "large-v3-turbo",
    bytes: 1_624_555_275,
    note: "recommended — near large-v3 accuracy at a fraction of the runtime"
  },
  {
    name: "ggml-large-v3.bin",
    label: "large-v3",
    bytes: 3_095_033_483,
    note: "most accurate, noticeably slower"
  },
  {
    name: "ggml-small.bin",
    label: "small",
    bytes: 487_601_967,
    note: "smallest download, weakest on short utterances"
  }
];

export const DEFAULT_MODEL_NAME = "ggml-large-v3-turbo.bin";

// Same host the upstream `models/download-ggml-model.sh` uses, which is what
// `scripts/install-whisper-cpp.sh` already invokes. Verified 2026-09-16:
// the `ggml-org` mirror answers 401, `ggerganov` answers 200.
const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export function findModelSpec(name: string): WhisperModelSpec | undefined {
  return WHISPER_MODELS.find((model) => model.name === name);
}

/** Directory holding the models, shared by dev and packaged builds. */
export function modelsDir(): string {
  const override = process.env.MARSHAL_MODELS_DIR;
  if (override && override.trim()) return override.trim();
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Marshal", "models");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Marshal", "models");
  }
  return path.join(os.homedir(), ".local", "share", "marshal", "models");
}

export function modelPath(name: string): string {
  return path.join(modelsDir(), name);
}

export function modelUrl(name: string): string {
  return `${MODEL_BASE_URL}/${name}`;
}

export interface InstalledModel {
  name: string;
  path: string;
  bytes: number;
}

/**
 * The model the dictation backend will actually use, or null when none is
 * installed. A file whose size does not match the spec is treated as present
 * anyway — the user may have supplied their own quantized build — but a
 * leftover `.part` is ignored.
 */
export function findInstalledModel(): InstalledModel | null {
  for (const model of WHISPER_MODELS) {
    const candidate = modelPath(model.name);
    if (!existsSync(candidate)) continue;
    try {
      const { size } = statSync(candidate);
      if (size > 0) return { name: model.name, path: candidate, bytes: size };
    } catch {
      // Unreadable — treat as absent and try the next one.
    }
  }
  return null;
}

/**
 * Where a resumed download should pick up. A `.part` at or beyond the expected
 * size is junk rather than a resume point — appending to it would produce a
 * file that is the right length in the wrong places, which whisper-cli would
 * then fail to parse in a far more confusing way.
 */
export function resumeOffset(partialSize: number, expectedBytes: number): number {
  if (!Number.isFinite(partialSize) || partialSize <= 0) return 0;
  return partialSize < expectedBytes ? partialSize : 0;
}

export function sizeMismatchMessage(actual: number, spec: WhisperModelSpec): string {
  return (
    `Model download is ${actual} bytes but ${spec.name} should be ${spec.bytes}. ` +
    "The partial file was discarded — try again."
  );
}

export interface DownloadProgress {
  /** Bytes on disk so far, including anything a resumed download already had. */
  received: number;
  total: number;
  /** 0–1, or null when the server did not say how big the file is. */
  ratio: number | null;
}

export interface DownloadModelOptions {
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Downloads `name` into the models directory and returns its final path.
 *
 * Writes to `<name>.part` and renames only after the size checks out, so an
 * interrupted download can never leave a truncated file that whisper-cli
 * would later fail to parse in a much more confusing way. An existing
 * `.part` is resumed with a Range request.
 */
export async function downloadModel(
  name: string = DEFAULT_MODEL_NAME,
  options: DownloadModelOptions = {}
): Promise<string> {
  const spec = findModelSpec(name);
  if (!spec) {
    throw new Error(`Unknown whisper model "${name}". Known: ${WHISPER_MODELS.map((m) => m.name).join(", ")}`);
  }

  const doFetch = options.fetchImpl ?? fetch;
  const target = modelPath(name);
  const partial = `${target}.part`;
  await fs.mkdir(path.dirname(target), { recursive: true });

  let alreadyHave = 0;
  try {
    const { size } = await fs.stat(partial);
    alreadyHave = resumeOffset(size, spec.bytes);
    if (alreadyHave === 0) await fs.rm(partial, { force: true });
  } catch {
    alreadyHave = 0;
  }

  const headers: Record<string, string> = {};
  if (alreadyHave > 0) headers.Range = `bytes=${alreadyHave}-`;

  const response = await doFetch(modelUrl(name), { headers, signal: options.signal });
  if (!response.ok) {
    throw new Error(`Model download failed: HTTP ${response.status} for ${modelUrl(name)}`);
  }
  if (!response.body) {
    throw new Error(`Model download failed: empty response body for ${modelUrl(name)}`);
  }

  // We asked to resume but got the whole file — start the part file over
  // rather than appending a second copy of the header.
  const resuming = alreadyHave > 0 && response.status === 206;
  if (alreadyHave > 0 && !resuming) {
    await fs.rm(partial, { force: true });
    alreadyHave = 0;
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  const total = resuming || !Number.isFinite(declared) || declared <= 0
    ? spec.bytes
    : declared;

  let received = alreadyHave;
  options.onProgress?.({ received, total, ratio: total > 0 ? received / total : null });

  const sink = createWriteStream(partial, { flags: resuming ? "a" : "w" });
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    options.onProgress?.({ received, total, ratio: total > 0 ? received / total : null });
  });

  try {
    await pipeline(source, sink);
  } catch (err) {
    // Keep the `.part` file: the next attempt resumes from here.
    throw err instanceof Error ? err : new Error(String(err));
  }

  const { size } = await fs.stat(partial);
  if (size !== spec.bytes) {
    await fs.rm(partial, { force: true });
    throw new Error(sizeMismatchMessage(size, spec));
  }

  await fs.rename(partial, target);
  return target;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
