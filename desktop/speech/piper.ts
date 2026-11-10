// Local neural Ukrainian voice for spoken updates (#325): Piper's uk_UA lada
// voice run by the sherpa-onnx `sherpa-onnx-offline-tts` CLI, one process per
// phrase, so nothing stays in memory between phrases (#281).
//
// Pinned to sherpa-onnx v1.13.8: v2.x dropped espeak-ng and fails on Piper
// voices with "no frontend available". The ukrainian_tts voices (lada /
// mykyta / tetiana medium) expect stressed Cyrillic text from a Python
// frontend; through this CLI they come out as noise, so only lada x_low ships.
// The rhasspy/piper macOS release is an x86_64 binary with missing dylibs.

import { execFile } from "node:child_process";
import { createWriteStream, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { modelsDir } from "../dictation/model-installer.ts";
import { DEFAULT_SPEECH_RATE, normalizeSpeechRate } from "./speech-policy.ts";

const execFileAsync = promisify(execFile);

const SHERPA_VERSION = "v1.13.8";
const RUNTIME_DIR = `sherpa-onnx-${SHERPA_VERSION}-osx-arm64-shared`;
const VOICE_DIR = "vits-piper-uk_UA-lada-x_low-int8";
const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export const PIPER_VOICE_LABEL = "Piper · Lada (uk_UA)";

type PiperArchive = {
  url: string;
  /** Exact upstream size; anything else is a truncated or replaced download. */
  bytes: number;
  /** Only what synthesis needs: the runtime archive carries ~30 other CLIs. */
  members: string[];
};

export const PIPER_ARCHIVES: readonly PiperArchive[] = [
  {
    url: `${RELEASES}/${SHERPA_VERSION}/${RUNTIME_DIR}.tar.bz2`,
    bytes: 20_314_448,
    members: [`${RUNTIME_DIR}/bin/sherpa-onnx-offline-tts`, `${RUNTIME_DIR}/lib`]
  },
  {
    url: `${RELEASES}/tts-models/${VOICE_DIR}.tar.bz2`,
    bytes: 13_332_976,
    members: [VOICE_DIR]
  }
];

export const PIPER_DOWNLOAD_BYTES = PIPER_ARCHIVES.reduce((sum, archive) => sum + archive.bytes, 0);

export type PiperPaths = {
  binary: string;
  model: string;
  tokens: string;
  dataDir: string;
};

/** Next to the whisper model: outside every app bundle, shared by dev and packaged builds. */
export function piperDir(): string {
  return path.join(modelsDir(), "piper");
}

export function piperPaths(root = piperDir()): PiperPaths {
  const voice = path.join(root, VOICE_DIR);
  return {
    binary: path.join(root, RUNTIME_DIR, "bin", "sherpa-onnx-offline-tts"),
    model: path.join(voice, "uk_UA-lada-x_low.onnx"),
    tokens: path.join(voice, "tokens.txt"),
    dataDir: path.join(voice, "espeak-ng-data")
  };
}

export function isPiperInstalled(paths = piperPaths()): boolean {
  return Object.values(paths).every((file) => existsSync(file));
}

/** `say -r` words per minute → VITS length scale (larger = slower); the default rate keeps the voice's own pace. */
export function lengthScaleForRate(rate: unknown): number {
  return Math.round((DEFAULT_SPEECH_RATE / normalizeSpeechRate(rate)) * 100) / 100;
}

export function buildPiperArgs(paths: PiperPaths, text: string, wavPath: string, rate: unknown): string[] {
  return [
    `--vits-model=${paths.model}`,
    `--vits-tokens=${paths.tokens}`,
    `--vits-data-dir=${paths.dataDir}`,
    `--vits-length-scale=${lengthScaleForRate(rate)}`,
    "--num-threads=2",
    `--output-filename=${wavPath}`,
    // Ends the options: text starting with "-" would otherwise parse as a flag.
    "--",
    text
  ];
}

/** Downloads the runtime and the voice (~33 MB) and unpacks only what synthesis needs. */
export async function installPiper(options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch;
  const root = piperDir();
  await fs.mkdir(root, { recursive: true });
  for (const archive of PIPER_ARCHIVES) {
    const file = path.join(root, path.basename(archive.url));
    try {
      const response = await doFetch(archive.url, { signal: options.signal });
      if (!response.ok || !response.body) throw new Error(`Piper download failed: HTTP ${response.status} for ${archive.url}`);
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(file)
      );
      const { size } = await fs.stat(file);
      if (size !== archive.bytes) {
        throw new Error(`Piper download ${path.basename(file)} is ${size} bytes, expected ${archive.bytes}. Try again.`);
      }
      await execFileAsync("/usr/bin/tar", ["-xjf", file, "-C", root, ...archive.members], { timeout: 120_000 });
    } finally {
      await fs.rm(file, { force: true });
    }
  }
  if (!isPiperInstalled()) throw new Error(`Piper unpacked into ${root}, but files are missing.`);
}
