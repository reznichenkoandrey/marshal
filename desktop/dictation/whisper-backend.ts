// desktop/dictation/whisper-backend.ts
// Abstraction over audio transcription providers. Keeps dictation-service.ts
// free of provider-specific plumbing so we can swap local whisper.cpp for
// Groq/OpenAI/etc. without touching orchestration.

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asarUnpacked } from "../utils/asar-paths.ts";
import { WHISPER_MODELS, modelPath } from "./model-installer.ts";
import { ResidentWhisperBackend, sharedWhisperServer } from "./whisper-server.ts";

export type TranscribeResult = {
  text: string;
  language?: string;
};

export type TranscribeOptions = {
  /** ISO 639-1 language code. Omit or pass "auto" for auto-detect. */
  language?: string;
  /**
   * Initial prompt fed to whisper. Used as a glossary + style hint — names,
   * English loanwords, punctuation style, typical code-switching. Dramatically
   * improves accuracy on mixed-language speech and rare technical terms.
   *
   * Whisper caps this at the last ~224 tokens internally, so keep it under
   * ~1000 characters. Longer prompts get silently truncated from the start.
   */
  prompt?: string;
};

export interface WhisperBackend {
  transcribe(wavPath: string, options?: TranscribeOptions): Promise<TranscribeResult>;
}

export type BackendName = "whisper-cpp" | "groq" | "hybrid";

/**
 * Resolve the active dictation backend.
 *
 * Default ("" / unset) — auto-pick: `hybrid` if `MARSHAL_API_KEY` is set
 * (Groq with local fallback), `whisper-cpp` otherwise (pure local). Users
 * can pin to a single provider with `groq` or `whisper-cpp`. See #93.
 */
export function resolveBackendName(raw: string | undefined): BackendName {
  const value = (raw ?? "").toLowerCase().trim();
  if (value === "groq") return "groq";
  if (value === "whisper-cpp") return "whisper-cpp";
  if (value === "hybrid") return "hybrid";
  // Unset / unknown — auto-pick by capability.
  if (process.env.MARSHAL_API_KEY) return "hybrid";
  return "whisper-cpp";
}

/**
 * Default dictation glossary. Seeds Whisper with the vocabulary this user
 * actually produces — Ukrainian base with surzhyk + inline Americanisms +
 * Anthropic / Claude Code tooling — so the model preserves code-switching
 * instead of "correcting" loanwords into nonsense or dropping rare terms.
 *
 * Whisper caps the initial prompt at the last ~224 tokens (~800 chars),
 * silently truncating from the start. Order matters: keep the verbatim
 * directive first, then the highest-payoff vocabulary.
 *
 * Override via MARSHAL_DICTATION_PROMPT or the settings textarea when a
 * user talks about domains we don't cover here (medicine, law, gaming).
 */
export const DEFAULT_DICTATION_PROMPT =
  "Записати дослівно українською, зберігаючи суржик та англіцизми як вимовлено, не виправляти. " +
  "Розробник: React, Vue, TypeScript, Python, PHP, Magento, Hyva, Tailwind, Vite, Docker, Playwright. " +
  "Інструменти: Claude Code, Sonnet, Opus, Haiku, Cursor, GitHub, Linear, Figma, Notion, MCP, agents, skills, hooks, plugins, slash commands. " +
  "Marshal: dictation, focus-probe, codesign, Electron, tray, hotkey, side panel. " +
  "Англіцизми: deploy, refactor, scope, scope creep, blocker, ETA, regression, mock, stub, e2e, prod, dev, staging, sandbox, prod-ready, rollback, hotfix, feature flag. " +
  "Workflow: запушити PR, смерджити branch, задеплоїти, закомітити, зробити code review, написати unit test, дебажити, refactor, merge conflict, pull request, commit, push, release. " +
  "Архітектура: API, backend, frontend, endpoint, middleware, repository, pipeline, CI/CD.";

export function resolveDictationPrompt(raw: string | undefined): string {
  if (typeof raw !== "string") return DEFAULT_DICTATION_PROMPT;
  const trimmed = raw.trim();
  // Caller explicitly blanked the prompt — respect that.
  if (trimmed === "") return "";
  return trimmed;
}

export function resolveDictationLanguage(raw: string | undefined): string | undefined {
  const value = (raw ?? "uk").toLowerCase().trim();
  if (!value || value === "auto") return undefined;
  return value.slice(0, 2);
}

export function createWhisperBackend(name: BackendName): WhisperBackend {
  if (name === "groq") return new GroqWhisperBackend();
  if (name === "hybrid") return new HybridWhisperBackend();
  return createLocalWhisperBackend();
}

/**
 * Local whisper.cpp: the resident server when its binary is present (#218),
 * with whisper-cli behind it as the fallback; whisper-cli alone otherwise.
 * `MARSHAL_WHISPER_SERVER=0` turns the server off.
 */
export function createLocalWhisperBackend(): WhisperBackend {
  const cli = new WhisperCppBackend();
  const serverBin = process.env.MARSHAL_WHISPER_SERVER_BIN ?? resolveDefaultServerBin();
  if ((process.env.MARSHAL_WHISPER_SERVER ?? "1").trim() === "0" || !existsSync(serverBin)) return cli;
  const { model } = resolveWhisperAssetPaths();
  const server = sharedWhisperServer({ bin: serverBin, model, threads: resolveWhisperThreads() });
  return new ResidentWhisperBackend(server, cli);
}

function resolveWhisperThreads(): number {
  const parsed = Number.parseInt(process.env.MARSHAL_WHISPER_THREADS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

// ── whisper.cpp (local, offline, free) ──

export class WhisperCppBackend implements WhisperBackend {
  private readonly bin: string;
  private readonly model: string;
  private readonly threads: number;

  constructor() {
    this.bin = process.env.MARSHAL_WHISPER_BIN ?? resolveDefaultBin();
    this.model = process.env.MARSHAL_WHISPER_MODEL ?? resolveDefaultModel();
    this.threads = resolveWhisperThreads();
  }

  async transcribe(wavPath: string, options: TranscribeOptions = {}): Promise<TranscribeResult> {
    await fs.access(this.bin).catch(() => {
      throw new Error(
        `whisper.cpp binary not found at ${this.bin}. Run ./scripts/install-whisper-cpp.sh first.`
      );
    });
    await fs.access(this.model).catch(() => {
      throw new Error(
        `whisper.cpp model not found at ${this.model}. Run ./scripts/install-whisper-cpp.sh first.`
      );
    });

    const args = [
      "-m", this.model,
      "-f", wavPath,
      "-l", options.language ?? "auto",
      "-t", String(this.threads),
      "--no-prints",
      "--output-txt",
      "--output-file", wavPath.replace(/\.wav$/u, "")
    ];
    // whisper.cpp docs: `--prompt` seeds the decoder with prior context, which
    // primes the vocabulary + style. Huge accuracy win on rare terms and
    // mixed-language speech. Empty string means "no prompt".
    if (options.prompt && options.prompt.length > 0) {
      args.push("--prompt", options.prompt);
    }

    const stderr = await new Promise<string>((resolve, reject) => {
      let errBuf = "";
      const child = spawn(this.bin, args, { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.on("data", (chunk: Buffer) => {
        errBuf += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(errBuf);
        else reject(new Error(`whisper-cli exited with code ${code}: ${errBuf.slice(0, 500)}`));
      });
    });

    const txtPath = wavPath.replace(/\.wav$/u, ".txt");
    const text = await fs.readFile(txtPath, "utf8").catch(() => "");
    await fs.unlink(txtPath).catch(() => undefined);

    return {
      text: text.trim(),
      language: parseDetectedLanguage(stderr)
    };
  }
}

// ── Groq (fallback / optional paid backend) ──

export class GroqWhisperBackend implements WhisperBackend {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor() {
    this.apiKey = process.env.MARSHAL_API_KEY ?? "";
    this.baseUrl = (process.env.MARSHAL_API_BASE ?? "https://api.groq.com/openai/v1").replace(/\/+$/u, "");
    this.model = process.env.MARSHAL_WHISPER_MODEL_REMOTE ?? "whisper-large-v3";
  }

  async transcribe(wavPath: string, options: TranscribeOptions = {}): Promise<TranscribeResult> {
    if (!this.apiKey) throw new Error("MARSHAL_API_KEY is required for Groq whisper backend.");

    const wav = await fs.readFile(wavPath);
    const form = new FormData();
    form.append("model", this.model);
    form.append("file", new Blob([wav], { type: "audio/wav" }), path.basename(wavPath));
    if (options.language) form.append("language", options.language);
    // OpenAI-compatible audio/transcriptions endpoint accepts an optional
    // `prompt` field (≤ 224 tokens) that seeds the decoder's context. Identical
    // semantics to whisper.cpp's --prompt flag.
    if (options.prompt && options.prompt.length > 0) form.append("prompt", options.prompt);

    const resp = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      throw new Error(`Groq whisper API ${resp.status}: ${errText}`);
    }
    const data = (await resp.json()) as { text?: string; language?: string };
    return {
      text: (data.text ?? "").trim(),
      language: data.language
    };
  }
}

// ── Hybrid: Groq with local fallback ──

/**
 * Tries Groq first (cloud, whisper-large-v3, ~5–10× quality of ggml-small,
 * ~200 ms latency on Groq's free tier — 4 hrs audio/day, plenty for personal
 * use). Falls back to local whisper.cpp on any failure: network down,
 * 429 rate limit, 5xx, timeout. The fallback uses whichever local model the
 * user has installed (large-v3-turbo by default in fresh setups, but
 * back-compat with ggml-small for existing users who haven't re-run setup).
 *
 * Logs the fallback decision with `[whisper] Groq failed → local fallback`
 * when MARSHAL_DICTATION_DEBUG is set, so latency surprises are diagnosable.
 */
export class HybridWhisperBackend implements WhisperBackend {
  private readonly primary: GroqWhisperBackend;
  // The resident server when available (#218), so a Groq 429 costs ~0.7 s
  // locally instead of whisper-cli's 1.6 s.
  private readonly fallback: WhisperBackend;

  constructor() {
    this.primary = new GroqWhisperBackend();
    this.fallback = createLocalWhisperBackend();
  }

  async transcribe(wavPath: string, options: TranscribeOptions = {}): Promise<TranscribeResult> {
    try {
      return await this.primary.transcribe(wavPath, options);
    } catch (err) {
      // Always logged: this used to print only with MARSHAL_DICTATION_DEBUG=1,
      // which made "no fallback in the log" look like "no fallback happened"
      // while a Groq rate limit was quietly sending finals to the slower
      // local path (#217).
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[whisper] Groq failed → local fallback: ${msg.split("\n")[0].slice(0, 300)}`);
      return this.fallback.transcribe(wavPath, options);
    }
  }
}

// ── helpers ──

/**
 * whisper-cli prints lines like `whisper_full_with_state: auto-detected language: uk (...)`.
 * Extract the code so callers can learn the detected language even though we
 * ignore stdout audio timeline.
 */
export function parseDetectedLanguage(stderr: string): string | undefined {
  const match = stderr.match(/auto-detected language:\s*([a-z]{2})/iu);
  return match ? match[1].toLowerCase() : undefined;
}

// Resolve paths relative to the COMPILED JS file rather than `process.cwd()`.
// In dev, this lands at `dist/desktop/dictation/`, and the postbuild script has
// already copied whisper-cli + model into that directory. In a packaged build,
// the same path inside the .app resolves to `app.asar.unpacked/dist/desktop/
// dictation/` thanks to the `asarUnpack` rule in package.json — so production
// finds the binary in the same relative spot as dev.
//
// Fallback chain (used when the bundled copy is missing):
//   1. Bundled: `<dist>/desktop/dictation/whisper-cli`
//   2. Project-local: `<project_root>/.whisper/bin/whisper-cli`
//      — used in dev before `npm run setup:dictation` ran the rebuild.
//
// The MODEL is resolved differently: it is never bundled (a 1.5 GB .app is
// not worth shipping), so the shared models directory outside any app bundle
// comes first — see model-installer.ts for why that directory and not
// `app.getPath("userData")`.
// asarUnpacked() — `child_process.spawn` cannot descend into app.asar (#82).
// The whisper model file is also referenced through this path because
// whisper-cli loads it with fopen() — that's an OS syscall, not an Electron
// fs call, so the asar→asar.unpacked redirect does not apply.
const distDictationDirOnDisk = asarUnpacked(path.dirname(fileURLToPath(import.meta.url)));

function firstExisting(candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

export function resolveDefaultBin(): string {
  return firstExisting([
    path.join(distDictationDirOnDisk, "whisper-cli"),
    path.join(process.cwd(), ".whisper", "bin", "whisper-cli")
  ]);
}

/** Same search as `resolveDefaultBin`, for the resident server (#218). */
export function resolveDefaultServerBin(): string {
  return firstExisting([
    path.join(distDictationDirOnDisk, "whisper-server"),
    path.join(process.cwd(), ".whisper", "bin", "whisper-server")
  ]);
}

/**
 * Every place a model may live, in the order they are tried. Model priority
 * is the outer loop and location the inner one: a turbo model already on disk
 * beats a freshly downloaded `small`, wherever each of them sits.
 */
export function whisperModelCandidates(): string[] {
  const candidates: string[] = [];
  for (const model of WHISPER_MODELS) {
    candidates.push(modelPath(model.name));
    candidates.push(path.join(process.cwd(), ".whisper", "models", model.name));
    candidates.push(path.join(distDictationDirOnDisk, model.name));
  }
  return candidates;
}

export function resolveDefaultModel(): string {
  // Search order per model name, in install priority (turbo, large-v3,
  // small — see WHISPER_MODELS):
  //   1. the shared models directory — where the in-app download and
  //      `npm run setup:dictation` both put it,
  //   2. the dev `.whisper/models/` tree — older checkouts that downloaded
  //      before the model moved out of the bundle,
  //   3. the packaged dist dir — builds up to 0.2.0 shipped the model inside
  //      the .app, and an installed copy should keep working.
  //
  // whisper-cli loads the model via its own fopen() call, so (3) needs the
  // asar-unpacked path, same as the binary.
  return firstExisting(whisperModelCandidates());
}

/** A local model and a binary to run it are both on disk. */
export function isLocalWhisperAvailable(): boolean {
  const { bin, model } = resolveWhisperAssetPaths();
  const serverBin = process.env.MARSHAL_WHISPER_SERVER_BIN ?? resolveDefaultServerBin();
  return existsSync(model) && (existsSync(bin) || existsSync(serverBin));
}

export function resolveWhisperAssetPaths(): { bin: string; model: string } {
  return {
    bin: process.env.MARSHAL_WHISPER_BIN ?? resolveDefaultBin(),
    model: process.env.MARSHAL_WHISPER_MODEL ?? resolveDefaultModel()
  };
}
