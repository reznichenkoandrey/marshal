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

const CLAUDE_BIN = process.env.MARSHAL_CLAUDE_BIN ?? "claude";
const DEFAULT_MODEL = process.env.MARSHAL_CLAUDE_MODEL ?? "sonnet";
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 60_000;

/**
 * Claude Code CLI auto-selects API-key billing whenever ANTHROPIC_API_KEY is
 * present. Strip every ANTHROPIC_ and CLAUDE_CODE_USE_ variable so translations
 * stay on the user's Pro/Max OAuth subscription.
 */
function sanitizeEnvForSubscription(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("ANTHROPIC_")) continue;
    if (key === "CLAUDE_CODE_USE_BEDROCK" || key === "CLAUDE_CODE_USE_VERTEX") continue;
    if (typeof value === "string") clean[key] = value;
  }
  return clean;
}

type ClaudeJsonResult = {
  type?: string;
  is_error?: boolean;
  result?: string;
};

/**
 * Translator backend that delegates to the local `claude` CLI so translations
 * are billed to the user's Claude Pro/Max subscription instead of an API key.
 *
 * Requires `claude` on PATH + `claude auth` completed. Image OCR relies on
 * Claude's multimodal Read tool: we write the image to a tmp file, allow
 * the CLI read access to that directory via `--add-dir`, and ask for the
 * extracted translation.
 */
export class ClaudeCliTranslatorBackend implements TranslatorBackend {
  readonly id: TranslatorBackendId = "claude-cli";

  async translateText(text: string, targetLang: TargetLang): Promise<TranslationResult> {
    const prompt = buildTranslateJsonPrompt(text, targetLangName(targetLang));
    const raw = await this.runClaude(
      ["-p", "--output-format", "json", "--model", DEFAULT_MODEL, "--tools", "", "--permission-mode", "bypassPermissions"],
      prompt
    );
    const inner = this.extractInnerResult(raw);
    const parsed = parseTranslateJson(inner);
    return {
      translation: parsed.translation,
      sourceLang: parsed.sourceLang || detectLangHeuristic(text),
      targetLang
    };
  }

  async translateImage(base64: string, mimeType: string, targetLang: TargetLang): Promise<TranslationResult> {
    const targetName = targetLangName(targetLang);
    const extension = mimeExtension(mimeType);
    const dir = tmpdir();
    const file = join(dir, `marshal-translate-${randomUUID()}.${extension}`);
    await fs.writeFile(file, Buffer.from(base64, "base64"));

    const prompt =
      `Read the image file at ${file}. Extract ALL visible text from it and translate to ${targetName}. ` +
      `If the text is already in ${targetName}, return it unchanged. ` +
      `Output ONLY the final translated text — no commentary, no explanations, no JSON.`;

    try {
      const raw = await this.runClaude(
        [
          "-p",
          "--output-format", "json",
          "--model", DEFAULT_MODEL,
          "--add-dir", dir,
          "--tools", "Read",
          "--permission-mode", "bypassPermissions"
        ],
        prompt
      );
      const translation = this.extractInnerResult(raw).trim();
      return { translation, sourceLang: "auto", targetLang };
    } finally {
      await fs.unlink(file).catch(() => {});
    }
  }

  private extractInnerResult(raw: string): string {
    let parsed: ClaudeJsonResult;
    try {
      parsed = JSON.parse(raw.trim()) as ClaudeJsonResult;
    } catch {
      throw new Error(`Claude CLI returned non-JSON output: ${raw.slice(0, 500)}`);
    }
    if (parsed.is_error) {
      throw new Error(`Claude CLI reported an error: ${parsed.result ?? "unknown"}`);
    }
    return parsed.result ?? "";
  }

  private runClaude(args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, args, {
        stdio: ["pipe", "pipe", "pipe"],
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
        reject(new Error(`Claude CLI timed out after ${PROCESS_TIMEOUT_MS}ms`));
      }, PROCESS_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_BUFFER_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          child.kill("SIGKILL");
          reject(new Error(`Claude CLI stdout exceeded ${MAX_BUFFER_BYTES} bytes`));
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
        reject(new Error(`Failed to spawn ${CLAUDE_BIN}: ${err.message}. Install Claude Code CLI and run \`claude auth\`.`));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${CLAUDE_BIN} exited with code ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
        }
      });

      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}

