// One workflow run: `claude -p` as a child process with a hard timeout (#280).

import { spawn } from "node:child_process";

import { withoutHostSessionEnv } from "../assistant/dispatcher-files.ts";
import type { WorkflowDefinition } from "./definition.ts";

export const KILL_GRACE_MS = 5_000;

export type RunOutcome = { status: "ok"; output: string } | { status: "failed"; reason: "timeout" | "exit" | "empty" | "missing-binary"; error?: string };

export interface ProcessOptions {
  input: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  killGraceMs?: number;
}

/** Everything outside `allowedTools` is refused without a prompt: nobody is there to answer one. */
export function claudeArgs(definition: WorkflowDefinition): string[] {
  const args = ["-p", "--output-format", "json", "--model", definition.model, "--permission-mode", "dontAsk"];
  if (definition.allowedTools.length > 0) args.push("--allowedTools", ...definition.allowedTools);
  return args;
}

/** Billing stays on the subscription (#322) and the run is not a child of a desktop session (#388). */
export function workflowEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = withoutHostSessionEnv(env);
  for (const key of Object.keys(clean)) {
    if (key.startsWith("ANTHROPIC_")) delete clean[key];
  }
  return clean;
}

function lastLine(text: string): string | undefined {
  return text.trim().split("\n").pop()?.trim() || undefined;
}

/** Runs a command with the prompt on stdin; SIGTERM at the timeout, SIGKILL after the grace period. */
export function runProcess(command: string, args: string[], options: ProcessOptions): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? KILL_GRACE_MS);
    }, options.timeoutMs);
    const finish = (outcome: RunOutcome): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(outcome);
    };

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
    child.stdin.on("error", () => {});
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ status: "failed", reason: err.code === "ENOENT" ? "missing-binary" : "exit", error: err.message });
    });
    child.on("close", (code) => {
      if (timedOut) finish({ status: "failed", reason: "timeout" });
      else if (code !== 0) finish({ status: "failed", reason: "exit", error: lastLine(stderr) ?? `exit code ${code}` });
      else if (!stdout.trim()) finish({ status: "failed", reason: "empty" });
      else finish({ status: "ok", output: stdout });
    });
    child.stdin.end(options.input);
  });
}

export function runWorkflow(definition: WorkflowDefinition): Promise<RunOutcome> {
  return runProcess(process.env.MARSHAL_CLAUDE_BIN ?? "claude", claudeArgs(definition), {
    input: definition.prompt,
    env: workflowEnv(process.env),
    timeoutMs: definition.timeoutMs
  });
}
