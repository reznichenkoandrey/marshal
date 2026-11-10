// HolosTTS Ukrainian voice for spoken updates (#333): patriotyk/HolosTTS (MIT)
// int8 ONNX with the Python stress + IPA frontend it needs. Opt-in exception to
// the "no Python runtime" budget (#281): installed on demand outside the bundle,
// loaded on the first phrase and stopped after HOLOS_IDLE_MS, like whisper-server.
//
// Everything is pinned: uv (size + sha256), Python 3.12, the HF revision, the
// frontend git commits and the resolved package versions. The runtime is
// offline (HF_HUB_OFFLINE): only the install talks to the network.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, promises as fs, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { modelsDir } from "../dictation/model-installer.ts";
import { DEFAULT_SPEECH_RATE, normalizeSpeechRate } from "./speech-policy.ts";

const execFileAsync = promisify(execFile);

const UV_VERSION = "0.13.5";
const UV_TRIPLE = "uv-aarch64-apple-darwin";
export const UV_ARCHIVE = {
  url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_TRIPLE}.tar.gz`,
  bytes: 14_365_303,
  sha256: "743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73"
};
const PYTHON_VERSION = "3.12";
export const HOLOS_REPO = "patriotyk/HolosTTS";
export const HOLOS_REVISION = "5d40fbaa99e55ebd3359a161bc86728ffdbd5c5f";

export const HOLOS_REQUIREMENTS = [
  "holos-tts-onnx==0.4",
  // Only the voice encoder for "Add voice from recording"; synthesis stays on ONNX.
  "holos-tts==0.4",
  // Archives, not git+: /usr/bin/git is a shim that asks to install the Command Line Tools.
  "ukrainian-word-stress @ https://github.com/patriotyk/ukrainian-word-stress/archive/d5b37ea0abe9711930d9c3b0b13edec5a0675512.tar.gz",
  "ipa-uk @ https://github.com/patriotyk/ipa-uk/archive/3faf05ec50fd4880965b6c76f8e479a4f82117f5.tar.gz"
];

// Versions the frontend was measured with (2026-11-10); a newer torch or
// stanza can change the stress model under us.
export const HOLOS_CONSTRAINTS = [
  "huggingface_hub==2.4.0",
  "librosa==1.0.0",
  "numpy==2.5.4",
  "onnxruntime==1.31.1",
  "scipy==1.18.1",
  "soundfile==0.14.0",
  "stanza==1.15.0",
  "torch==2.15.0",
  "torchaudio==2.11.1",
  "transformers==5.22.2",
  "ukrainian-accentor==0.1.1"
];

export const HOLOS_IDLE_MS = 10 * 60_000;
// Cold start measured at ~8.6 s on an M3 Pro; a first exec after install also pays Gatekeeper.
const HOLOS_START_TIMEOUT_MS = 90_000;
const HOLOS_REQUEST_TIMEOUT_MS = 60_000;
const VOICE_NAME_MAX = 40;

export type HolosPaths = {
  root: string;
  uv: string;
  python: string;
  script: string;
  voicesDir: string;
  manifest: string;
};

export type HolosVoices = { presets: string[]; custom: string[] };

export function holosDir(): string {
  return path.join(modelsDir(), "holos");
}

export function holosPaths(root = holosDir()): HolosPaths {
  return {
    root,
    uv: path.join(root, UV_TRIPLE, "uv"),
    python: path.join(root, "venv", "bin", "python"),
    script: path.join(root, "holos_server.py"),
    voicesDir: path.join(root, "voices"),
    manifest: path.join(root, "installed.json")
  };
}

/** The manifest is written last, so its presence means the whole install finished. */
export function isHolosInstalled(paths = holosPaths()): boolean {
  return existsSync(paths.manifest) && existsSync(paths.python) && existsSync(paths.script);
}

export function listHolosVoices(paths = holosPaths()): HolosVoices {
  let presets: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(paths.manifest, "utf8")) as { voices?: unknown };
    if (Array.isArray(parsed.voices)) presets = parsed.voices.filter((v): v is string => typeof v === "string");
  } catch {
    // Not installed yet.
  }
  let custom: string[] = [];
  try {
    custom = readdirSync(paths.voicesDir)
      .filter((file) => file.endsWith(".npy"))
      .map((file) => file.slice(0, -4))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // No cloned voices yet.
  }
  return { presets, custom };
}

/** A recording's file name → a voice name that is safe as a file name and readable in a select. */
export function voiceNameFromFile(file: string): string {
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  const cleaned = base
    .replace(/[^\p{L}\p{N} _-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, VOICE_NAME_MAX)
    .trim();
  return cleaned || "voice";
}

/** A cloned voice is passed to the server as its .npy path; anything else is a preset name. */
export function resolveHolosVoice(name: string, paths = holosPaths()): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const file = path.join(paths.voicesDir, `${trimmed}.npy`);
  return path.dirname(file) === paths.voicesDir && existsSync(file) ? file : trimmed;
}

/** `say -r` words per minute → Holos speed (larger = faster); the default rate keeps the voice's pace. */
export function holosSpeedForRate(rate: unknown): number {
  return Math.round((normalizeSpeechRate(rate) / DEFAULT_SPEECH_RATE) * 100) / 100;
}

export function holosEnv(paths: HolosPaths, offline: boolean): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
    HF_HOME: path.join(paths.root, "hf"),
    HF_HUB_DISABLE_TELEMETRY: "1",
    STANZA_RESOURCES_DIR: path.join(paths.root, "stanza"),
    TOKENIZERS_PARALLELISM: "false",
    OMP_NUM_THREADS: "4",
    ...(offline ? { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } : {})
  };
}

// JSON lines over stdin/stdout. Library output goes to stderr: fd 1 is
// re-pointed there before anything is imported, so a stray print from stanza
// or torch cannot corrupt the protocol.
export const HOLOS_SERVER_SCRIPT = String.raw`import json, os, sys

reply_stream = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr

REPO = "${HOLOS_REPO}"
REVISION = "${HOLOS_REVISION}"


def send(message):
    reply_stream.write(json.dumps(message, ensure_ascii=False) + "\n")
    reply_stream.flush()


def encoder_weights():
    from huggingface_hub import hf_hub_download
    return hf_hub_download(REPO, "voice_encoder.pt", revision=REVISION)


def main():
    import numpy as np
    import soundfile as sf
    from holos_onnx import HolosTTS
    from ipa_uk import ipa
    from ukrainian_word_stress import Stressifier

    stressify = Stressifier()
    tts = HolosTTS(REPO + "/onnx-int8", revision=REVISION)

    if sys.argv[1:] == ["prefetch"]:
        encoder_weights()
        send({"ready": True, "voices": tts.list_voices()})
        return

    send({"ready": True, "voices": tts.list_voices()})
    encoder = None
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        request_id = request.get("id")
        try:
            if "clone" in request:
                import torch
                from holos.models import VoiceEncoder
                if encoder is None:
                    weights = encoder_weights()
                    if not os.path.isfile(weights):
                        raise FileNotFoundError("voice_encoder.pt is missing; reinstall Holos")
                    encoder = VoiceEncoder(weights, device="cpu")
                with torch.inference_mode():
                    vector = encoder(request["clone"])
                np.save(request["out"], vector.squeeze().cpu().numpy().astype(np.float32))
            else:
                voice = request.get("voice") or None
                if voice and voice.endswith(".npy"):
                    voice = np.load(voice, allow_pickle=False)
                audio = tts.generate(ipa(stressify(request["text"])), voice=voice, speed=float(request.get("speed", 1.0)))
                sf.write(request["out"], np.asarray(audio).squeeze(), tts.sample_rate)
            send({"id": request_id, "ok": True})
        except Exception as error:
            send({"id": request_id, "error": type(error).__name__ + ": " + str(error)})


main()
`;

async function download(url: string, file: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<void> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Holos download failed: HTTP ${response.status} for ${url}`);
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file));
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline((await fs.open(file)).createReadStream(), hash);
  return hash.digest("hex");
}

/**
 * Downloads uv, builds a venv with uv-managed Python, installs the pinned
 * packages and prefetches the model, stanza `uk` and the voice encoder
 * (≈2 GB on disk) into `<modelsDir>/holos/`. Re-running repairs a half install.
 */
export async function installHolos(options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<HolosVoices> {
  const paths = holosPaths();
  await fs.mkdir(paths.root, { recursive: true });
  await fs.rm(paths.manifest, { force: true });

  if (!existsSync(paths.uv)) {
    const archive = path.join(paths.root, path.basename(UV_ARCHIVE.url));
    try {
      await download(UV_ARCHIVE.url, archive, options.fetchImpl ?? fetch, options.signal);
      const { size } = await fs.stat(archive);
      if (size !== UV_ARCHIVE.bytes || (await sha256(archive)) !== UV_ARCHIVE.sha256) {
        throw new Error("uv download does not match the pinned release. Try again.");
      }
      await execFileAsync("/usr/bin/tar", ["-xzf", archive, "-C", paths.root, `${UV_TRIPLE}/uv`], { timeout: 60_000 });
    } finally {
      await fs.rm(archive, { force: true });
    }
  }

  const uvEnv = {
    ...holosEnv(paths, false),
    UV_NO_CONFIG: "1",
    UV_PYTHON_INSTALL_DIR: path.join(paths.root, "python"),
    UV_CACHE_DIR: path.join(paths.root, "uv-cache"),
    UV_PYTHON_PREFERENCE: "only-managed"
  };
  const run = (args: string[], timeout: number) =>
    execFileAsync(paths.uv, args, { env: uvEnv, cwd: paths.root, timeout, maxBuffer: 32 * 1024 * 1024 });
  try {
    if (!existsSync(paths.python)) {
      await run(["venv", "--quiet", "--python", PYTHON_VERSION, path.join(paths.root, "venv")], 10 * 60_000);
    }
    const requirements = path.join(paths.root, "requirements.txt");
    const constraints = path.join(paths.root, "constraints.txt");
    await fs.writeFile(requirements, `${HOLOS_REQUIREMENTS.join("\n")}\n`, "utf8");
    await fs.writeFile(constraints, `${HOLOS_CONSTRAINTS.join("\n")}\n`, "utf8");
    await run(["pip", "install", "--quiet", "--python", paths.python, "-r", requirements, "-c", constraints], 30 * 60_000);
  } finally {
    await fs.rm(uvEnv.UV_CACHE_DIR, { recursive: true, force: true });
  }

  await fs.writeFile(paths.script, HOLOS_SERVER_SCRIPT, "utf8");
  await fs.mkdir(paths.voicesDir, { recursive: true });
  const { stdout } = await execFileAsync(paths.python, ["-I", paths.script, "prefetch"], {
    env: holosEnv(paths, false),
    cwd: paths.root,
    timeout: 30 * 60_000,
    maxBuffer: 32 * 1024 * 1024
  });
  const ready = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as { voices?: unknown };
  const voices = Array.isArray(ready.voices) ? ready.voices.filter((v): v is string => typeof v === "string") : [];
  if (voices.length === 0) throw new Error("Holos installed, but the model reported no voices.");
  await fs.writeFile(paths.manifest, JSON.stringify({ revision: HOLOS_REVISION, voices }, null, 2), "utf8");
  return listHolosVoices(paths);
}

type Pending = { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/**
 * One resident Holos process for the app: started by the first request,
 * stopped after `idleMs` without one. Requests are answered in order by id.
 */
export class HolosServer {
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly paths = holosPaths(),
    private readonly idleMs = HOLOS_IDLE_MS
  ) {}

  isRunning(): boolean {
    return this.child !== null;
  }

  /** Loads the model ahead of a phrase that is about to come (a voice command was just sent). */
  warmUp(): void {
    if (!isHolosInstalled(this.paths)) return;
    void this.start()
      .then(() => this.armIdle())
      .catch((err: unknown) => console.warn("[holos] warm-up failed:", err instanceof Error ? err.message : err));
  }

  synthesize(text: string, voice: string, rate: unknown, wavPath: string): Promise<void> {
    return this.request({ text, voice: resolveHolosVoice(voice, this.paths), speed: holosSpeedForRate(rate), out: wavPath });
  }

  async cloneVoice(recording: string): Promise<string> {
    const name = voiceNameFromFile(recording);
    await fs.mkdir(this.paths.voicesDir, { recursive: true });
    await this.request({ clone: recording, out: path.join(this.paths.voicesDir, `${name}.npy`) });
    return name;
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    this.child = null;
    this.starting = null;
    this.failAll(new Error("Holos stopped"));
    // EOF ends the read loop; the process exits on its own.
    child?.stdin?.end();
    if (child) setTimeout(() => child.kill(), 2_000).unref();
  }

  private async request(body: Record<string, unknown>): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try {
      const child = await this.start();
      const id = ++this.nextId;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("Holos did not answer in time"));
        }, HOLOS_REQUEST_TIMEOUT_MS);
        this.pending.set(id, { resolve, reject, timer });
        child.stdin?.write(`${JSON.stringify({ id, ...body })}\n`);
      });
    } finally {
      this.armIdle();
    }
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.pending.size > 0 || !this.child) return;
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref();
  }

  private start(): Promise<ChildProcess> {
    if (this.child) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    if (!isHolosInstalled(this.paths)) return Promise.reject(new Error("Holos is not installed"));
    const starting = new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn(this.paths.python, ["-I", this.paths.script], {
        cwd: this.paths.root,
        env: holosEnv(this.paths, true),
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stderrTail = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2_000);
      });
      child.stdin?.on("error", () => {});
      const timer = setTimeout(() => {
        reject(new Error("Holos did not start in time"));
        child.kill();
      }, HOLOS_START_TIMEOUT_MS);
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let message: { ready?: boolean; id?: number; ok?: boolean; error?: string };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          return;
        }
        if (message.ready) {
          clearTimeout(timer);
          if (this.starting === starting) {
            this.child = child;
            this.starting = null;
          }
          resolve(child);
          return;
        }
        const entry = message.id === undefined ? undefined : this.pending.get(message.id);
        if (!entry || message.id === undefined) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve();
        else entry.reject(new Error(message.error ?? "Holos request failed"));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        const reason = stderrTail.trim().split("\n").pop() || `exit ${code ?? signal}`;
        reject(new Error(`Holos exited: ${reason}`));
        if (this.child === child) {
          this.child = null;
          this.failAll(new Error(`Holos exited: ${reason}`));
        }
        if (this.starting === starting) this.starting = null;
      });
    });
    this.starting = starting;
    return starting;
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}
