import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ReasoningBridge, ReasoningBridgeOptions } from "./types.ts";

const CODEX_BIN = process.env.MARSHAL_CODEX_BIN ?? "codex";
const CODEX_MODEL = process.env.MARSHAL_CODEX_MODEL ?? "";
const MAX_HISTORY = 40;
const TRIM_TO = 30;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Codex CLI prefers an API key over the ChatGPT OAuth session whenever
 * OPENAI_API_KEY is present. Strip it so the subscription is used.
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

type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

/**
 * Codex CLI bridge. Uses the local `codex` binary as a subprocess so the
 * reasoning cost is billed to the user's ChatGPT Plus/Pro/Business/Enterprise
 * subscription instead of the OpenAI API.
 *
 * Requires: `codex` CLI on PATH and `codex login` already completed with the
 * ChatGPT account option.
 *
 * Unlike Claude Code, we do not rely on `codex exec resume` here: options
 * diverge between `exec` and `exec resume` across versions. Instead the bridge
 * rolls the conversation into one flat prompt on every turn. Marshal's
 * one-shot executor typically has <= 2 turns per task, so the overhead is
 * negligible.
 */
export class CodexCliBridge implements ReasoningBridge {
  private systemPrompt: string | null = null;
  private history: HistoryTurn[] = [];

  constructor(_options: ReasoningBridgeOptions = {}) {}

  async initialize(): Promise<void> {
    try {
      await this.runCodex(["--version"]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Codex CLI not available (${CODEX_BIN}). Install it (\`npm i -g @openai/codex\` or \`brew install codex\`) and run \`codex login\` with your ChatGPT subscription. Detail: ${detail}`
      );
    }
  }

  async openLoginWindow(): Promise<void> {
    // Auth is delegated to the `codex login` subcommand.
  }

  async resetConversation(): Promise<void> {
    this.history = [];
  }

  async prime(initialPrompt: string): Promise<void> {
    this.systemPrompt = initialPrompt;
  }

  async ask(prompt: string): Promise<string> {
    this.history.push({ role: "user", content: prompt });
    const fullPrompt = this.buildPromptWithHistory();

    const outputFile = join(tmpdir(), `marshal-codex-${randomUUID()}.txt`);
    const args: string[] = [
      "exec",
      "--skip-git-repo-check",
      "--json",
      "-s", "read-only",
      "-o", outputFile
    ];
    if (CODEX_MODEL) {
      args.push("-m", CODEX_MODEL);
    }
    args.push(fullPrompt);

    try {
      await this.runCodex(args);
      const content = await fs.readFile(outputFile, "utf8").catch(() => "");
      const trimmed = content.trim();
      this.history.push({ role: "assistant", content: trimmed });
      this.trimHistory();
      return trimmed;
    } finally {
      await fs.unlink(outputFile).catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.history = [];
    this.systemPrompt = null;
  }

  private buildPromptWithHistory(): string {
    const parts: string[] = [];
    if (this.systemPrompt) {
      parts.push(`[SYSTEM]\n${this.systemPrompt}`);
    }
    for (const turn of this.history) {
      const label = turn.role === "user" ? "USER" : "ASSISTANT";
      parts.push(`[${label}]\n${turn.content}`);
    }
    parts.push("[ASSISTANT]");
    return parts.join("\n\n");
  }

  private trimHistory(): void {
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-TRIM_TO);
    }
  }

  private runCodex(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(CODEX_BIN, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizeEnvForSubscription(process.env)
      });

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_BUFFER_BYTES) {
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
        reject(new Error(`Failed to spawn ${CODEX_BIN}: ${err.message}`));
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`${CODEX_BIN} exited with code ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
        }
      });
    });
  }
}
