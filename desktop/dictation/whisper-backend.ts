// desktop/dictation/whisper-backend.ts
// Abstraction over audio transcription providers. Keeps dictation-service.ts
// free of provider-specific plumbing so we can swap local whisper.cpp for
// Groq/OpenAI/etc. without touching orchestration.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export type TranscribeResult = {
  text: string;
  language?: string;
};

export interface WhisperBackend {
  transcribe(wavPath: string, language?: string): Promise<TranscribeResult>;
}

export type BackendName = "whisper-cpp" | "groq";

export function resolveBackendName(raw: string | undefined): BackendName {
  const value = (raw ?? "").toLowerCase().trim();
  if (value === "groq") return "groq";
  return "whisper-cpp";
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

  async transcribe(wavPath: string, language?: string): Promise<TranscribeResult> {
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
      "-l", language ?? "auto",
      "-t", String(this.threads),
      "--no-prints",
      "--output-txt",
      "--output-file", wavPath.replace(/\.wav$/u, "")
    ];

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

  async transcribe(wavPath: string, language?: string): Promise<TranscribeResult> {
    if (!this.apiKey) throw new Error("MARSHAL_API_KEY is required for Groq whisper backend.");

    const wav = await fs.readFile(wavPath);
    const form = new FormData();
    form.append("model", this.model);
    form.append("file", new Blob([wav], { type: "audio/wav" }), path.basename(wavPath));
    if (language) form.append("language", language);

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

function resolveDefaultBin(): string {
  return path.join(process.cwd(), ".whisper", "bin", "whisper-cli");
}

function resolveDefaultModel(): string {
  return path.join(process.cwd(), ".whisper", "models", "ggml-small.bin");
}
