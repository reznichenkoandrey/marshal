// One workflow run: `claude -p` as a child process with a hard timeout (#280).

import { spawn } from "node:child_process";

import fs from "node:fs";

import { withoutHostSessionEnv } from "../assistant/dispatcher-files.ts";
import { buildRunPrompt, OUTPUT_SCHEMA, parseRunOutput, type RunResult } from "./contract.ts";
import type { WorkflowDefinition } from "./definition.ts";
import type { WorkflowStore } from "./store.ts";

export const KILL_GRACE_MS = 5_000;

export type FailureReason = "timeout" | "exit" | "empty" | "missing-binary" | "contract" | "auth";
export type ProcessOutcome = { status: "ok"; output: string } | { status: "failed"; reason: FailureReason; error?: string };
export type RunOutcome = { status: "ok"; result: RunResult } | { status: "failed"; reason: FailureReason; error?: string };

export interface ProcessOptions {
  input: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
  killGraceMs?: number;
}

/** Everything outside `allowedTools` is refused without a prompt: nobody is there to answer one. */
export function claudeArgs(definition: WorkflowDefinition): string[] {
  const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(OUTPUT_SCHEMA), "--model", definition.model, "--permission-mode", "dontAsk"];
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
export function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? KILL_GRACE_MS);
    }, options.timeoutMs);
    const finish = (outcome: ProcessOutcome): void => {
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

export type RunProcess = (definition: WorkflowDefinition, prompt: string) => Promise<ProcessOutcome>;

/**
 * One run end to end: prompt with the previous memory, the process, the
 * contract check with one retry that quotes the validator, then the memory
 * write. Memory is replaced only by a run that passed the contract.
 */
export async function executeWorkflow(definition: WorkflowDefinition, store: WorkflowStore, run: RunProcess, now: () => number = Date.now): Promise<RunOutcome> {
  const memory = store.readMemory(definition, now());
  let validatorError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await run(definition, buildRunPrompt(definition, memory, validatorError));
    if (outcome.status === "failed") return outcome;
    const parsed = parseRunOutput(outcome.output);
    if (parsed.ok) {
      if (parsed.result.memory) store.writeMemory(definition, parsed.result.memory);
      return { status: "ok", result: parsed.result };
    }
    if (parsed.reason !== "contract") return { status: "failed", reason: parsed.reason, error: parsed.error };
    validatorError = parsed.error;
  }
  return { status: "failed", reason: "contract", error: validatorError };
}

/** Runs `claude -p` in the workflows' own empty folder, so no project's CLAUDE.md or settings load. */
export function claudeProcess(runDir: string): RunProcess {
  return (definition, prompt) => {
    fs.mkdirSync(runDir, { recursive: true });
    return runProcess(process.env.MARSHAL_CLAUDE_BIN ?? "claude", claudeArgs(definition), {
      input: prompt,
      env: workflowEnv(process.env),
      cwd: runDir,
      timeoutMs: definition.timeoutMs
    });
  };
}
