// desktop/dictation/whisper-backend.ts
// Abstraction over audio transcription providers. Keeps dictation-service.ts
// free of provider-specific plumbing so we can swap local whisper.cpp for
// Groq/OpenAI/etc. without touching orchestration.

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asarUnpacked } from "../utils/asar-paths.ts";

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

export type BackendName = "whisper-cpp" | "groq";

export function resolveBackendName(raw: string | undefined): BackendName {
  const value = (raw ?? "").toLowerCase().trim();
  if (value === "groq") return "groq";
  return "whisper-cpp";
}

/**
 * Default dictation glossary. Seeds whisper with the vocabulary this user
 * actually produces — Ukrainian base with inline English technical terms —
 * so that short commands like "закомить PR" or "запусти Vite" don't get
 * transliterated into nonsense.
 *
 * Override via MARSHAL_DICTATION_PROMPT or the settings textarea when a user
 * talks about domains we don't cover here (medicine, law, gaming, etc.).
 */
export const DEFAULT_DICTATION_PROMPT =
  "Я розробник, працюю над React, Vue, TypeScript, Python, PHP, Magento проєктами. " +
  "Використовую Claude Code, Cursor, GitHub, Linear, Figma, Notion, Playwright, Vite, Tailwind, Docker. " +
  "Говорю українською з англіцизмами: запушити PR, смерджити branch, задеплоїти, закомітити, зробити code review, " +
  "написати unit test, debug, refactor, merge conflict, pull request, commit, push, release, feature flag, hotfix, rollback. " +
  "Також: API, backend, frontend, endpoint, middleware, repository, pipeline, CI/CD, staging, production, sandbox.";

export function resolveDictationPrompt(raw: string | undefined): string {
  if (typeof raw !== "string") return DEFAULT_DICTATION_PROMPT;
  const trimmed = raw.trim();
  // Caller explicitly blanked the prompt — respect that.
  if (trimmed === "") return "";
  return trimmed;
}

export function createWhisperBackend(name: BackendName): WhisperBackend {
  if (name === "groq") return new GroqWhisperBackend();
  return new WhisperCppBackend();
}

// ── whisper.cpp (local, offline, free) ──

export class WhisperCppBackend implements WhisperBackend {
  private readonly bin: string;
  private readonly model: string;
  private readonly threads: number;

  constructor() {
    this.bin = process.env.MARSHAL_WHISPER_BIN ?? resolveDefaultBin();
    this.model = process.env.MARSHAL_WHISPER_MODEL ?? resolveDefaultModel();
    const parsed = Number.parseInt(process.env.MARSHAL_WHISPER_THREADS ?? "", 10);
    this.threads = Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
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
//   1. Bundled: `<dist>/desktop/dictation/{whisper-cli, ggml-small.bin}`
//   2. Project-local: `<project_root>/.whisper/{bin/whisper-cli, models/ggml-small.bin}`
//      — used in dev before `npm run setup:dictation` ran the rebuild.
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

function resolveDefaultBin(): string {
  return firstExisting([
    path.join(distDictationDirOnDisk, "whisper-cli"),
    path.join(process.cwd(), ".whisper", "bin", "whisper-cli")
  ]);
}

function resolveDefaultModel(): string {
  // whisper-cli loads the model via its own fopen() call — that's also an
  // OS-level path, so it needs the unpacked path too.
  return firstExisting([
    path.join(distDictationDirOnDisk, "ggml-small.bin"),
    path.join(process.cwd(), ".whisper", "models", "ggml-small.bin")
  ]);
}
