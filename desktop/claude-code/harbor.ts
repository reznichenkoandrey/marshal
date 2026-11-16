// Client for Harbor's control socket (#425): the owner's terminal app keeps the
// assistant's sessions in one System group instead of a Terminal window each.
// Contract: one JSON object per line each way; see Harbor's README.

import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type TerminalHost = "auto" | "harbor" | "terminal";

export const HARBOR_APP = "/Applications/Harbor.app";
const REQUEST_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 15_000;
const START_POLL_MS = 250;

export type HarborRequest =
  | { op: "open"; name: string; cwd: string; command: string; reveal: boolean }
  | { op: "focus"; name?: string; tty?: string }
  | { op: "list" };

export type HarborSession = { id: string; name: string; cwd: string; tty: string | null; pid: number | null };

export type HarborResponse =
  | { ok: true; session?: HarborSession; sessions?: HarborSession[] }
  | { ok: false; error: string };

export function harborSocketPath(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Harbor", "control.sock");
}

/** `auto` = Harbor when it is installed, Terminal otherwise. */
export function usesHarbor(host: TerminalHost, installed: boolean = fs.existsSync(HARBOR_APP)): boolean {
  return host === "harbor" || (host === "auto" && installed);
}

/** Harbor is not running, or quit and left no socket behind. */
function notRunning(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

export function harborRequest(request: HarborRequest, socketPath = harborSocketPath(), timeoutMs = REQUEST_TIMEOUT_MS): Promise<HarborResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Harbor did not answer"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as HarborResponse);
      } catch {
        reject(new Error("Harbor sent a malformed reply"));
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function launchHarbor(): Promise<void> {
  return new Promise((resolve, reject) => {
    // LaunchServices hands Harbor launchd's env, not Marshal's: no keys, no host-session vars (#322, #388).
    execFile("open", ["-g", "-a", "Harbor", "--args", "--background"], (err) => (err ? reject(err) : resolve()));
  });
}

export type HarborCallOptions = { socketPath?: string; launch?: () => Promise<void>; startTimeoutMs?: number };

/** Sends the request, starting Harbor in the background (no window) first when it is not running. */
export async function harborCall(request: HarborRequest, options: HarborCallOptions = {}): Promise<HarborResponse> {
  const socketPath = options.socketPath ?? harborSocketPath();
  try {
    return await harborRequest(request, socketPath);
  } catch (err) {
    if (!notRunning(err)) throw err;
  }
  await (options.launch ?? launchHarbor)();
  const deadline = Date.now() + (options.startTimeoutMs ?? START_TIMEOUT_MS);
  for (;;) {
    try {
      return await harborRequest(request, socketPath);
    } catch (err) {
      if (!notRunning(err) || Date.now() > deadline) throw new Error(`Harbor did not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
}
