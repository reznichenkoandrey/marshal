import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { ReasoningBridge, ReasoningBridgeOptions } from "./types.ts";

const CLAUDE_BIN = process.env.MARSHAL_CLAUDE_BIN ?? "claude";
const DEFAULT_MODEL = process.env.MARSHAL_CLAUDE_MODEL ?? "sonnet";
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
// Cap single-turn wall time so a stuck CLI (auth reprompt, network freeze,
// runaway generation) doesn't hang the whole task forever. Configurable via
// env for slow networks / very long docs.
const TURN_TIMEOUT_MS = Number(process.env.MARSHAL_CLAUDE_TIMEOUT_MS ?? 120_000);
const DEBUG = process.env.MARSHAL_AGENT_DEBUG === "1";
// Claude Code CLI auto-loads ./CLAUDE.md from its working directory. When the
// Electron app spawns the CLI inline, cwd defaults to the marshal project
// root — so Claude reads our dev-time house rules and thinks every user
// question is about this repo. Force the CLI into a neutral tmpdir so the
// browser side-panel chat stays generic.
const NEUTRAL_CWD = tmpdir();

/**
 * Claude Code CLI auto-selects API-key billing whenever ANTHROPIC_API_KEY is
 * present in the environment, even if the user has an active Pro/Max OAuth
 * session. To guarantee the reasoning cost is billed to the subscription we
 * strip any API-key-style variables before spawning the subprocess.
 */
function sanitizeEnvForSubscription(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    // Strip every ANTHROPIC_* variable. Any of them can flip Claude Code from
    // OAuth subscription mode into API-key mode or a custom endpoint:
    //   ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BEARER_TOKEN → API billing
    //   ANTHROPIC_BASE_URL / ANTHROPIC_VERTEX_* / CLAUDE_CODE_USE_BEDROCK → 3P provider
    //   ANTHROPIC_MODEL → overrides model selection
    if (key.startsWith("ANTHROPIC_")) continue;
    if (key === "CLAUDE_CODE_USE_BEDROCK" || key === "CLAUDE_CODE_USE_VERTEX") continue;
    if (typeof value === "string") clean[key] = value;
  }
  return clean;
}

type ClaudeJsonResult = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
};

/**
 * Claude Code CLI bridge. Uses the local `claude` binary as a subprocess
 * so the reasoning cost is billed to the user's Claude Pro/Max subscription
 * instead of the Anthropic API.
 *
 * Requires: `claude` CLI on PATH and `claude auth` already completed.
 * Conversation continuity is achieved via --session-id / --resume.
 * All built-in Claude Code tools are disabled — the bridge is used purely
 * as a reasoning engine; Marshal's own Toolbox executes side effects.
 */
export class ClaudeCliBridge implements ReasoningBridge {
  private sessionId: string | null = null;
  private systemPrompt: string | null = null;

  constructor(_options: ReasoningBridgeOptions = {}) {}

  async initialize(): Promise<void> {
    try {
      await this.runClaude(["--version"], "");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Claude CLI not available (${CLAUDE_BIN}). Install it from https://docs.claude.com/claude-code and run \`claude auth\` with your Pro/Max subscription. Detail: ${detail}`
      );
    }
  }

  async openLoginWindow(): Promise<void> {
    // Auth is delegated to the `claude auth` subcommand outside of this process.
  }

  async resetConversation(): Promise<void> {
    this.sessionId = null;
  }

  async prime(initialPrompt: string): Promise<void> {
    this.systemPrompt = initialPrompt;
  }

  async ask(prompt: string): Promise<string> {
    const isFirstTurn = this.sessionId === null;
    // Arg rationale:
    //   -p                        — non-interactive "print" mode.
    //   --output-format json      — single JSON result blob (see ClaudeJsonResult).
    //   --tools ""                — disable EVERY built-in tool. The empty
    //                               string is the documented sentinel per
    //                               `claude --help`: "Use \"\" to disable
    //                               all tools". Marshal's own Toolbox is the
    //                               sole source of side effects.
    //   --permission-mode bypassPermissions — belt & suspenders: even if a
    //                               tool slips through the above, it cannot
    //                               prompt interactively.
    const args: string[] = [
      "-p",
      "--output-format", "json",
      "--model", DEFAULT_MODEL,
      "--tools", "",
      "--permission-mode", "bypassPermissions"
    ];

    if (isFirstTurn) {
      const newId = randomUUID();
      this.sessionId = newId;
      args.push("--session-id", newId);
      if (this.systemPrompt) {
        args.push("--system-prompt", this.systemPrompt);
      }
    } else {
      args.push("--resume", this.sessionId as string);
    }

    const raw = await this.runClaude(args, prompt);

    let parsed: ClaudeJsonResult;
    try {
      parsed = JSON.parse(raw.trim()) as ClaudeJsonResult;
    } catch {
      throw new Error(`Claude CLI returned non-JSON output: ${raw.slice(0, 500)}`);
    }

    if (parsed.is_error) {
      throw new Error(`Claude CLI reported an error: ${parsed.result ?? "unknown"}`);
    }

    if (typeof parsed.session_id === "string" && parsed.session_id.length > 0) {
      this.sessionId = parsed.session_id;
    }

    return parsed.result ?? "";
  }

  async close(): Promise<void> {
    this.sessionId = null;
    this.systemPrompt = null;
  }

  private runClaude(args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      if (DEBUG) {
        process.stderr.write(`[claude-cli] → ${args.slice(0, 4).join(" ")}… (${stdin.length}B stdin)\n`);
      }

      const child = spawn(CLAUDE_BIN, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: sanitizeEnvForSubscription(process.env),
        cwd: NEUTRAL_CWD
      });

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let settled = false;

      // Hard timeout — SIGKILL if the CLI hasn't replied by TURN_TIMEOUT_MS.
      // Prevents indefinite hangs on auth re-prompts or silent network failures.
      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        reject(
          new Error(
            `Claude CLI timed out after ${TURN_TIMEOUT_MS}ms. ` +
            `Set MARSHAL_CLAUDE_TIMEOUT_MS to raise the cap, or run \`claude auth\` ` +
            `and verify your subscription session is valid.`
          )
        );
      }, TURN_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_BUFFER_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
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
        clearTimeout(timeoutHandle);
        reject(new Error(`Failed to spawn ${CLAUDE_BIN}: ${err.message}`));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (DEBUG) {
          process.stderr.write(
            `[claude-cli] ← exit ${code} in ${Date.now() - startedAt}ms (${stdout.length}B stdout)\n`
          );
        }
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${CLAUDE_BIN} exited with code ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
        }
      });

      if (stdin.length > 0) {
        child.stdin.write(stdin);
      }
      child.stdin.end();
    });
  }
}
