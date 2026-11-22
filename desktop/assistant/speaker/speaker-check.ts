// Speaker check (#287), stages S1–S3: the embedding path, enrolment from a recording, the
// voice print on disk and the decision for one wake clip. Spec: docs/SPEAKER_CHECK.md.
//
// The Swift helper (`speaker-embed.swift`) runs the sherpa-onnx speaker extractor for one
// check and exits, so no model stays in memory between commands (#281). The model (~28 MB)
// is downloaded on demand into the models dir; the runtime is the wake phrase's when it is
// already there.
//
// The voice print is biometric data: one JSON file under userData, mode 0600, never in the repo.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { modelsDir } from "../../dictation/model-installer.ts";
import { installArchives, RELEASES, RUNTIME_DIR, SHERPA_VERSION, type InstallOptions } from "../../speech/piper.ts";
import { voiceBaseName } from "../../speech/speech-policy.ts";
import { asarUnpacked } from "../../utils/asar-paths.ts";
import {
  calibrate,
  cosineSimilarity,
  decideSpeaker,
  DEFAULT_CALIBRATION,
  percentile,
  type Calibration,
  type CalibrationParams,
  type SpeakerDecision
} from "./calibration.ts";

const execFileAsync = promisify(execFile);

// CAM++ trained on ~200k Chinese and English speakers (3D-Speaker): the widest speaker set among
// the ~28 MB models of the release. Not measured on Ukrainian speech yet.
export const SPEAKER_MODEL = {
  file: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
  // "recongition" is the upstream tag's own spelling.
  url: `${RELEASES}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`,
  bytes: 28_281_165,
  sha256: "53cab20ba8f2eb2f6e2d89ecc18e88ef3222169b61b4419cbc13666744a4574b"
} as const;

const RUNTIME_ARCHIVE = {
  url: `${RELEASES}/${SHERPA_VERSION}/${RUNTIME_DIR}.tar.bz2`,
  bytes: 20_314_448,
  members: [`${RUNTIME_DIR}/lib`]
};

const HELPER = path.join(asarUnpacked(path.dirname(fileURLToPath(import.meta.url))), "speaker-embed");
const LIB_FILE = "libsherpa-onnx-c-api.dylib";
const ENROL_WINDOW_S = 3;
const ENROL_HOP_S = 1;
const MAX_FOREIGN_VOICES = 30;
const MAX_OWNER_LEVELS = 50;
const CHECK_TIMEOUT_MS = 10_000;

export type SpeakerPaths = { lib: string; model: string };

export function speakerDir(): string {
  return path.join(modelsDir(), "speaker");
}

/** The wake phrase's sherpa runtime when it is installed, else the speaker check's own copy. */
export function speakerPaths(root = speakerDir(), wakeRoot = path.join(modelsDir(), "wake")): SpeakerPaths {
  const shared = path.join(wakeRoot, RUNTIME_DIR, "lib");
  return {
    lib: existsSync(path.join(shared, LIB_FILE)) ? shared : path.join(root, RUNTIME_DIR, "lib"),
    model: path.join(root, SPEAKER_MODEL.file)
  };
}

export function isSpeakerInstalled(paths = speakerPaths()): boolean {
  return existsSync(path.join(paths.lib, LIB_FILE)) && existsSync(paths.model);
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Downloads the model (size and sha256 checked) and, where the wake phrase has not brought it, the runtime. */
export async function installSpeaker(options: InstallOptions & { root?: string; wakeRoot?: string } = {}): Promise<void> {
  const root = options.root ?? speakerDir();
  const paths = speakerPaths(root, options.wakeRoot);
  await fs.mkdir(root, { recursive: true });
  if (!existsSync(path.join(paths.lib, LIB_FILE))) await installArchives(root, [RUNTIME_ARCHIVE], options);
  if (existsSync(paths.model)) return;
  const partial = `${paths.model}.download`;
  try {
    const response = await (options.fetchImpl ?? fetch)(SPEAKER_MODEL.url, { signal: options.signal });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} for ${SPEAKER_MODEL.url}`);
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(partial));
    const { size } = await fs.stat(partial);
    if (size !== SPEAKER_MODEL.bytes) throw new Error(`Speaker model is ${size} bytes, expected ${SPEAKER_MODEL.bytes}. Try again.`);
    if ((await sha256Of(partial)) !== SPEAKER_MODEL.sha256) throw new Error("Speaker model checksum does not match. Try again.");
    await fs.rename(partial, paths.model);
  } finally {
    await fs.rm(partial, { force: true });
  }
}

// MARK: - Embeddings

export type EmbedRow = { file: number; start: number; levelDb: number; embedding: number[] };

/** The helper's stdout: one JSON object per line; error lines and anything malformed are skipped. */
export function parseEmbedOutput(stdout: string): EmbedRow[] {
  const rows: EmbedRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const row = JSON.parse(line) as Partial<EmbedRow>;
      if (
        typeof row.file === "number" &&
        Array.isArray(row.embedding) &&
        row.embedding.length > 0 &&
        row.embedding.every((value) => typeof value === "number" && Number.isFinite(value))
      ) {
        rows.push({ file: row.file, start: Number(row.start) || 0, levelDb: Number(row.levelDb), embedding: row.embedding });
      }
    } catch {
      // Not a row.
    }
  }
  return rows;
}

export type EmbedFiles = (files: string[], options?: { windowed?: boolean }) => Promise<EmbedRow[]>;

export const embedFiles: EmbedFiles = async (files, options = {}) => {
  const paths = speakerPaths();
  const windowed = options.windowed ? ["--window", String(ENROL_WINDOW_S), "--hop", String(ENROL_HOP_S)] : [];
  const { stdout } = await execFileAsync(HELPER, ["--lib", paths.lib, "--model", paths.model, ...windowed, ...files], {
    timeout: options.windowed ? 180_000 : CHECK_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024
  });
  return parseEmbedOutput(stdout);
};

// MARK: - Voice print

export type SpeakerProfile = {
  version: 1;
  model: string;
  createdAt: number;
  embedding: number[];
  calibration: Calibration;
  /** Levels of wake clips the check accepted, on the wake mic; feeds the quiet-voice filter. */
  ownerLevelsDb: number[];
};

function normalized(vector: readonly number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : [...vector];
}

function mean(vectors: readonly number[][]): number[] {
  return vectors[0]!.map((_, index) => vectors.reduce((sum, vector) => sum + vector[index]!, 0) / vectors.length);
}

/**
 * The voice print and its threshold from one recording cut into overlapping windows.
 * Windows far quieter than the rest are pauses and are dropped. The owner's own scores are
 * leave-one-out: each window against the mean of the windows that share no audio with it.
 */
export function buildProfile(
  windows: readonly EmbedRow[],
  foreign: readonly number[][],
  options: { windowSeconds?: number; now?: number; params?: CalibrationParams } = {}
): SpeakerProfile | null {
  const params = options.params ?? DEFAULT_CALIBRATION;
  const span = options.windowSeconds ?? ENROL_WINDOW_S;
  const usual = percentile(windows.map((row) => row.levelDb).filter(Number.isFinite), 50);
  const voiced = windows
    .filter((row) => usual === null || !(row.levelDb < usual - params.quietBelowDb))
    .map((row) => ({ start: row.start, embedding: normalized(row.embedding) }));
  if (voiced.length === 0) return null;
  const embedding = mean(voiced.map((row) => row.embedding));
  const ownerScores: number[] = [];
  for (const row of voiced) {
    const others = voiced.filter((other) => Math.abs(other.start - row.start) >= span);
    const score = others.length > 0 ? cosineSimilarity(row.embedding, mean(others.map((other) => other.embedding))) : null;
    if (score !== null) ownerScores.push(score);
  }
  const foreignScores = foreign.map((vector) => cosineSimilarity(embedding, vector)).filter((score): score is number => score !== null);
  return {
    version: 1,
    model: SPEAKER_MODEL.file,
    createdAt: options.now ?? Date.now(),
    embedding,
    calibration: calibrate(ownerScores, foreignScores, { foreignSynthetic: true, params }),
    ownerLevelsDb: []
  };
}

export async function loadProfile(file: string): Promise<SpeakerProfile | null> {
  try {
    const profile = JSON.parse(await fs.readFile(file, "utf8")) as SpeakerProfile;
    const usable = profile.version === 1 && profile.model === SPEAKER_MODEL.file && Array.isArray(profile.embedding) && profile.embedding.length > 0;
    return usable ? profile : null;
  } catch {
    return null;
  }
}

export async function saveProfile(file: string, profile: SpeakerProfile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const partial = `${file}.tmp`;
  await fs.writeFile(partial, JSON.stringify(profile), { mode: 0o600 });
  await fs.rename(partial, file);
}

export async function eraseProfile(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}

// MARK: - Synthetic foreign voices

// `say` voices that are effects, not people: they would pad the foreign side with easy rejections.
const NOVELTY_VOICES = new Set([
  "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Deranged", "Good News", "Hysterical",
  "Jester", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox"
]);
const SAMPLE_LINE = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#\s*(.+)$/;

export type SayVoiceSample = { name: string; text: string };

/** One sample sentence per distinct `say` voice, English and Ukrainian voices first. */
export function parseSayVoiceSamples(output: string, limit = MAX_FOREIGN_VOICES): SayVoiceSample[] {
  const seen = new Set<string>();
  const voices: Array<SayVoiceSample & { preferred: boolean }> = [];
  for (const line of output.split("\n")) {
    const match = SAMPLE_LINE.exec(line);
    if (!match) continue;
    const name = match[1]!.trim();
    // "Eddy (English (UK))" and "Eddy (German)" are one synthetic voice.
    const base = voiceBaseName(name);
    if (seen.has(base) || NOVELTY_VOICES.has(base)) continue;
    seen.add(base);
    // Said twice: the stock sentence alone is ~2 s, short for a stable embedding.
    voices.push({ name, text: `${match[3]!.trim()} ${match[3]!.trim()}`, preferred: /^(en|uk)_/.test(match[2]!) });
  }
  return [...voices.filter((voice) => voice.preferred), ...voices.filter((voice) => !voice.preferred)]
    .slice(0, limit)
    .map(({ name, text }) => ({ name, text }));
}

async function syntheticForeign(embed: EmbedFiles): Promise<number[][]> {
  const { stdout } = await execFileAsync("/usr/bin/say", ["-v", "?"]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marshal-speaker-"));
  try {
    const files: string[] = [];
    for (const [index, voice] of parseSayVoiceSamples(stdout).entries()) {
      const file = path.join(dir, `${index}.wav`);
      // A voice that fails to render is one sample fewer, not a failed enrolment.
      await execFileAsync("/usr/bin/say", ["-v", voice.name, "-o", file, "--data-format=LEI16@16000", "--", voice.text], { timeout: 30_000 })
        .then(() => files.push(file))
        .catch(() => undefined);
    }
    return files.length > 0 ? (await embed(files)).map((row) => row.embedding) : [];
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Builds the voice print from a recording of the owner and saves it; throws when the recording gives nothing. */
export async function enrolSpeaker(recording: string, profileFile: string, embed: EmbedFiles = embedFiles): Promise<SpeakerProfile> {
  const windows = await embed([recording], { windowed: true });
  const profile = windows.length > 0 ? buildProfile(windows, await syntheticForeign(embed)) : null;
  if (!profile) throw new Error("No speech found in the recording.");
  await saveProfile(profileFile, profile);
  return profile;
}

// MARK: - The check

export type SpeakerVerdict = SpeakerDecision & { score: number | null };

/**
 * Whether one wake clip sounds like the owner. Anything that keeps the check from running
 * (no voice print, no clip, a helper that fails or times out) accepts, so a broken check
 * never silently drops the owner's command; the caller logs the reason.
 */
export async function checkSpeaker(clip: string | null, profileFile: string, embed: EmbedFiles = embedFiles): Promise<SpeakerVerdict> {
  const profile = await loadProfile(profileFile);
  if (!profile) return { verdict: "accept", reason: "not-calibrated", score: null };
  const row = clip ? (await embed([clip]).catch(() => []))[0] : undefined;
  const score = row ? cosineSimilarity(profile.embedding, row.embedding) : null;
  const levelDb = row && Number.isFinite(row.levelDb) ? row.levelDb : undefined;
  const decision = decideSpeaker({ score, levelDb }, profile.calibration, { ownerLevelsDb: profile.ownerLevelsDb });
  if (decision.reason === "owner" && levelDb !== undefined) {
    const ownerLevelsDb = [...profile.ownerLevelsDb, levelDb].slice(-MAX_OWNER_LEVELS);
    await saveProfile(profileFile, { ...profile, ownerLevelsDb }).catch(() => undefined);
  }
  return { ...decision, score };
}
