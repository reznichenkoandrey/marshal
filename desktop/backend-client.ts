import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { utilityProcess, type UtilityProcess } from "electron";

import type {
  DesktopBackendMessage,
  DesktopBackendMethod,
  DesktopBackendRequest,
  DesktopBackendResponse
} from "./backend-types.ts";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type InvokeOptions = {
  timeoutMs?: number;
};

const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 20_000;

export class DesktopBackendClient {
  private readonly backendModulePath: string;
  private process: UtilityProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private readyPromise: Promise<void> | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimer: NodeJS.Timeout | null = null;

  constructor(backendModulePath = resolveDefaultBackendModulePath()) {
    this.backendModulePath = backendModulePath;
  }

  async invoke<T>(method: DesktopBackendMethod, ...rest: unknown[]): Promise<T> {
    // Allow the final argument to be an InvokeOptions bag without widening the
    // public signature. Keeps the common `invoke("x", arg1, arg2)` call site
    // unchanged while exposing a per-call timeout knob.
    let options: InvokeOptions = {};
    let params = rest;
    if (rest.length > 0 && isInvokeOptions(rest[rest.length - 1])) {
      options = rest[rest.length - 1] as InvokeOptions;
      params = rest.slice(0, -1);
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;

    const proc = this.ensureProcess();
    // Wait for the backend to finish its own initialize() before sending any
    // messages — utilityProcess.postMessage is lossy if the listener isn't
    // attached yet.
    await this.readyPromise;

    const requestId = randomUUID();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Desktop backend method "${method}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });

      const request: DesktopBackendRequest = {
        kind: "invoke",
        id: requestId,
        method,
        params
      };

      proc.postMessage(request);
    });
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Desktop backend client disposed."));
    }
    this.pending.clear();

    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.readyReject) {
      this.readyReject(new Error("Desktop backend client disposed before ready."));
    }
    this.readyReject = null;
    this.readyPromise = null;

    if (this.process) {
      const stale = this.process;
      // Null out first so the exit/message handlers see `this.process !== stale`
      // and bail out instead of rejecting pending requests on the replacement.
      this.process = null;
      stale.kill();
    }
  }

  /**
   * Like dispose() but waits for the child process to actually exit (with a
   * hard timeout). Use from `will-quit` so the app does not exit before the
   * backend has finished flushing and closing file handles.
   */
  async disposeAsync(timeoutMs = 3000): Promise<void> {
    const stale = this.process;
    if (!stale) {
      this.dispose();
      return;
    }

    const exitPromise = new Promise<void>((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          stale.removeListener("exit", onExit);
        } catch {
          // process already gone — nothing to clean up
        }
        resolve();
      }, timeoutMs);
      stale.once("exit", onExit);
    });

    this.dispose();
    await exitPromise;
  }

  async restart(): Promise<void> {
    this.dispose();
    this.ensureProcess();
    await this.readyPromise;
  }

  private ensureProcess(): UtilityProcess {
    if (this.process?.pid) {
      return this.process;
    }

    const child = utilityProcess.fork(this.backendModulePath);

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => {
        this.readyReject = null;
        this.readyTimer = null;
        reject(new Error(`Desktop backend did not become ready within ${READY_TIMEOUT_MS}ms.`));
      }, READY_TIMEOUT_MS);

      child.on("message", (message) => {
        // Ignore messages from processes that are no longer current (after a restart).
        if (this.process !== child) return;
        const payload = message as DesktopBackendMessage;
        if (payload?.kind === "ready") {
          if (this.readyTimer) {
            clearTimeout(this.readyTimer);
            this.readyTimer = null;
          }
          this.readyReject = null;
          resolve();
          return;
        }
        this.handleMessage(payload as DesktopBackendResponse);
      });
    });
    // Prevent unhandled rejection warnings for the ready promise — callers are
    // responsible for awaiting it via invoke().
    this.readyPromise.catch(() => undefined);

    child.on("exit", (code) => {
      // Race-guard: a stale exit (from a process killed by dispose/restart)
      // must not reject pending requests that belong to the replacement process.
      if (this.process !== child) return;
      const error = new Error(`Desktop backend exited with code ${code}.`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      if (this.readyTimer) {
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
      }
      if (this.readyReject) {
        this.readyReject(error);
        this.readyReject = null;
      }
      this.readyPromise = null;
      this.process = null;
    });

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        process.stdout.write(`[desktop-backend] ${String(chunk)}`);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        process.stderr.write(`[desktop-backend] ${String(chunk)}`);
      });
    }

    this.process = child;
    return child;
  }

  private handleMessage(message: DesktopBackendResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.kind === "success") {
      pending.resolve(message.result);
      return;
    }

    pending.reject(new Error(message.error));
  }
}

function isInvokeOptions(value: unknown): value is InvokeOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "timeoutMs" in value &&
    typeof (value as { timeoutMs?: unknown }).timeoutMs === "number"
  );
}

function resolveDefaultBackendModulePath(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  return path.join(path.dirname(currentFilePath), "backend.js");
}
