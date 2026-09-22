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

import { asarUnpacked } from "../../utils/asar-paths.ts";
import { OpenAiApiTranslatorBackend } from "./openai-api-backend.ts";
import { mimeExtension, ocrSourceLang, resolveSourceLang } from "./shared.ts";
import type {
  TargetLang,
  TranslateOptions,
  TranslationResult,
  TranslatorBackend,
  TranslatorBackendId
} from "./types.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const backendsDir = path.dirname(currentFilePath);
// backends/ → translator/ (one level up) → apple-vision-ocr binary.
// asarUnpacked() — `child_process.spawn` cannot descend into app.asar (#82).
const DEFAULT_BIN = path.join(asarUnpacked(path.join(backendsDir, "..")), "apple-vision-ocr");
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

  translateText(text: string, targetLang: TargetLang, options?: TranslateOptions): Promise<TranslationResult> {
    return this.textBackend.translateText(text, targetLang, options);
  }

  async translateImage(
    base64: string,
    mimeType: string,
    targetLang: TargetLang,
    options?: TranslateOptions
  ): Promise<TranslationResult> {
    const extension = mimeExtension(mimeType);
    const dir = tmpdir();
    const file = path.join(dir, `marshal-vision-${randomUUID()}.${extension}`);
    await fs.writeFile(file, Buffer.from(base64, "base64"));

    try {
      const recognized = (await this.runOcr(file)).trim();
      if (!recognized) {
        return { translation: "", sourceLang: ocrSourceLang(options), targetLang };
      }
      const result = await this.textBackend.translateText(recognized, targetLang, options);
      return {
        translation: result.translation,
        sourceLang: resolveSourceLang(recognized, result.sourceLang, options),
        targetLang
      };
    } finally {
      await fs.unlink(file).catch(() => {});
    }
  }

  private runOcr(imagePath: string): Promise<string> {
    return runAppleVisionOcr(imagePath);
  }
}

/**
 * Runs the Vision OCR helper on an image file and returns the recognized
 * text. Shared with the live captions overlay, which needs OCR without a
 * translation attached.
 */
export function runAppleVisionOcr(imagePath: string, timeoutMs = OCR_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(OCR_BIN, [imagePath], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(appleVisionSpawnError(err));
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
      reject(new Error(`apple-vision-ocr timed out after ${timeoutMs}ms`));
    }, timeoutMs);

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
      reject(appleVisionSpawnError(err));
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

function appleVisionSpawnError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(
    `Failed to launch apple-vision-ocr at ${OCR_BIN}: ${message}. ` +
    "Rebuild Marshal (npm run build) so the Swift helper is compiled. " +
    "macOS only — on other platforms switch translator backend to a cloud provider."
  );
}

// A 1×1 transparent PNG: enough to make the helper start and exit.
const WARM_UP_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const WARM_UP_TIMEOUT_MS = 90_000;

/**
 * Runs the helper once in the background so its first real call is fast.
 *
 * A freshly installed build carries a never-run, un-notarized hardened-runtime
 * binary, and macOS assesses it on first exec — measured at ~35 s on
 * macOS 27, against 0.4 s for every run after. That is longer than the OCR
 * timeout, so without this the first ⌘⇧2 and the first captions Ctrl+Shift+S
 * after an install always failed (#181). Errors are swallowed: the point is
 * the exec, not the result.
 */
export async function warmUpAppleVisionOcr(): Promise<void> {
  if (process.platform !== "darwin") return;
  const file = path.join(tmpdir(), `marshal-vision-warmup-${randomUUID()}.png`);
  const startedAt = Date.now();
  try {
    await fs.writeFile(file, WARM_UP_PNG);
    await runAppleVisionOcr(file, WARM_UP_TIMEOUT_MS);
  } catch (err) {
    // A Vision error on a 1×1 image is expected; a missing binary is logged
    // by the first real call with its actionable message.
    const message = err instanceof Error ? err.message : String(err);
    if (!/vision error|exited with code 2/iu.test(message)) {
      console.warn("[vision] warm-up:", message.split("\n")[0]);
    }
  } finally {
    await fs.unlink(file).catch(() => {});
    console.log(`[vision] apple-vision-ocr warm-up took ${Date.now() - startedAt} ms`);
  }
}
