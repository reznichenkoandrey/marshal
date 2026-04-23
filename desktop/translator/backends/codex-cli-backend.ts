import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TargetLang, TranslationResult, TranslatorBackend, TranslatorBackendId } from "./types.ts";
import {
  buildTranslateJsonPrompt,
  detectLangHeuristic,
  mimeExtension,
  parseTranslateJson,
  targetLangName
} from "./shared.ts";

const CODEX_BIN = process.env.MARSHAL_CODEX_BIN ?? "codex";
const CODEX_MODEL = process.env.MARSHAL_CODEX_MODEL ?? "";
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 90_000;

/**
 * Codex CLI prefers OPENAI_API_KEY over the ChatGPT OAuth session. Strip every
 * OPENAI_* credential so translations are billed to the user's ChatGPT Plus/Pro
 * subscription.
 */
function sanitizeEnvForSubscription(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = new Set(["OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT"]);
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (blocked.has(key)) continue;
    if (typeof value === "string") clean[key] = value;
  }
  return clean;
}

/**
 * Translator backend that delegates to the local `codex` CLI so translations
 * are billed to the user's ChatGPT subscription. Text goes through stdin via
 * `codex exec --skip-git-repo-check -s read-only -o <file>`; images are
 * attached via `-i <path>`.
 *
 * Requires `codex` on PATH + `codex login` completed with the ChatGPT account.
 */
export class CodexCliTranslatorBackend implements TranslatorBackend {
  readonly id: TranslatorBackendId = "codex-cli";

  async translateText(text: string, targetLang: TargetLang): Promise<TranslationResult> {
    const prompt = buildTranslateJsonPrompt(text, targetLangName(targetLang));
    const raw = await this.runCodex([], prompt);
    const parsed = parseTranslateJson(raw);
    return {
      translation: parsed.translation,
      sourceLang: parsed.sourceLang || detectLangHeuristic(text),
      targetLang
    };
  }

  async translateImage(base64: string, mimeType: string, targetLang: TargetLang): Promise<TranslationResult> {
    const targetName = targetLangName(targetLang);
    const extension = mimeExtension(mimeType);
    const imageFile = join(tmpdir(), `marshal-translate-${randomUUID()}.${extension}`);
    await fs.writeFile(imageFile, Buffer.from(base64, "base64"));

    const prompt =
      `Extract ALL visible text from the attached image and translate it to ${targetName}. ` +
      `If the text is already in ${targetName}, return it unchanged. ` +
      `Output ONLY the final translated text — no commentary, no explanations, no JSON.`;

    try {
      const raw = await this.runCodex(["-i", imageFile], prompt);
      return { translation: raw.trim(), sourceLang: "auto", targetLang };
    } finally {
      await fs.unlink(imageFile).catch(() => {});
    }
  }

  private async runCodex(extraArgs: string[], prompt: string): Promise<string> {
    const outputFile = join(tmpdir(), `marshal-codex-${randomUUID()}.txt`);
    const args: string[] = [
      "exec",
      "--skip-git-repo-check",
      "-s", "read-only",
      "-o", outputFile,
      ...extraArgs
    ];
    if (CODEX_MODEL) {
      args.push("-m", CODEX_MODEL);
    }
    args.push(prompt);

    try {
      await this.spawnCodex(args);
      const content = await fs.readFile(outputFile, "utf8").catch(() => "");
      return content.trim();
    } finally {
      await fs.unlink(outputFile).catch(() => {});
    }
  }

  private spawnCodex(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(CODEX_BIN, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizeEnvForSubscription(process.env)
      });

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`Codex CLI timed out after ${PROCESS_TIMEOUT_MS}ms`));
      }, PROCESS_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_BUFFER_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          child.kill("SIGKILL");
          reject(new Error(`Codex CLI stdout exceeded ${MAX_BUFFER_BYTES} bytes`));
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
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn ${CODEX_BIN}: ${err.message}. Install Codex CLI and run \`codex login\`.`));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${CODEX_BIN} exited with code ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
        }
      });
    });
  }
}

