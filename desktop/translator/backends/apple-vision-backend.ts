// Apple Vision + OpenAI-compatible hybrid backend.
//
// Text translation runs through the OpenAI-compatible provider (Groq by
// default — fast, free). Image translation runs macOS's Vision framework
// locally for OCR, then feeds the extracted text through the same provider
// for translation. No images ever leave the machine — removes per-image API
// limits and keeps OCR latency under ~200 ms.
//
// Requires the compiled `apple-vision-ocr` Swift helper at
// `dist/desktop/translator/apple-vision-ocr` (produced by
// scripts/postbuild.mjs). Falls back to a clear error when missing.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { OpenAiApiTranslatorBackend } from "./openai-api-backend.ts";
import { detectLangHeuristic, mimeExtension } from "./shared.ts";
import type {
  TargetLang,
  TranslationResult,
  TranslatorBackend,
  TranslatorBackendId
} from "./types.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const backendsDir = path.dirname(currentFilePath);
// backends/ → translator/ (one level up) → apple-vision-ocr binary.
const DEFAULT_BIN = path.join(backendsDir, "..", "apple-vision-ocr");
const OCR_BIN = process.env.MARSHAL_APPLE_VISION_BIN ?? DEFAULT_BIN;
const OCR_TIMEOUT_MS = 10_000;
const OCR_MAX_STDOUT_BYTES = 2 * 1024 * 1024;

export class AppleVisionTranslatorBackend implements TranslatorBackend {
  readonly id: TranslatorBackendId = "apple-vision";
  private readonly textBackend: OpenAiApiTranslatorBackend;

  constructor() {
    // Reuse the existing OpenAI-compat transport. It honours MARSHAL_API_*
    // env vars so users can point it at Groq, OpenAI, OpenRouter, etc.
    this.textBackend = new OpenAiApiTranslatorBackend("openai-api");
  }

  translateText(text: string, targetLang: TargetLang): Promise<TranslationResult> {
    return this.textBackend.translateText(text, targetLang);
  }

  async translateImage(
    base64: string,
    mimeType: string,
    targetLang: TargetLang
  ): Promise<TranslationResult> {
    const extension = mimeExtension(mimeType);
    const dir = tmpdir();
    const file = path.join(dir, `marshal-vision-${randomUUID()}.${extension}`);
    await fs.writeFile(file, Buffer.from(base64, "base64"));

    try {
      const recognized = (await this.runOcr(file)).trim();
      if (!recognized) {
        return { translation: "", sourceLang: "auto", targetLang };
      }
      const result = await this.textBackend.translateText(recognized, targetLang);
      return {
        translation: result.translation,
        sourceLang: result.sourceLang || detectLangHeuristic(recognized),
        targetLang
      };
    } finally {
      await fs.unlink(file).catch(() => {});
    }
  }

  private runOcr(imagePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(OCR_BIN, [imagePath], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        reject(this.spawnError(err));
        return;
      }

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`apple-vision-ocr timed out after ${OCR_TIMEOUT_MS}ms`));
      }, OCR_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > OCR_MAX_STDOUT_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new Error(`apple-vision-ocr stdout exceeded ${OCR_MAX_STDOUT_BYTES} bytes`));
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(this.spawnError(err));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(
            `apple-vision-ocr exited with code ${code}: ${stderr.slice(0, 500) || "(no stderr)"}`
          ));
        }
      });
    });
  }

  private spawnError(err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err);
    return new Error(
      `Failed to launch apple-vision-ocr at ${OCR_BIN}: ${message}. ` +
      "Rebuild Marshal (npm run build) so the Swift helper is compiled. " +
      "macOS only — on other platforms switch translator backend to a cloud provider."
    );
  }
}
