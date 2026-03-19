import path from "node:path";
import { fileURLToPath } from "node:url";

import { utilityProcess, type UtilityProcess } from "electron";

import type { DesktopBackendMethod, DesktopBackendRequest, DesktopBackendResponse } from "./backend-types.ts";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class DesktopBackendClient {
  private readonly backendModulePath: string;
  private process: UtilityProcess | null = null;
  private requestCounter = 0;
  private pending = new Map<string, PendingRequest>();

  constructor(backendModulePath = resolveDefaultBackendModulePath()) {
    this.backendModulePath = backendModulePath;
  }

  async invoke<T>(method: DesktopBackendMethod, ...params: unknown[]): Promise<T> {
    const process = this.ensureProcess();
    const requestId = `${Date.now()}-${this.requestCounter++}`;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject
      });

      const request: DesktopBackendRequest = {
        kind: "invoke",
        id: requestId,
        method,
        params
      };

      process.postMessage(request);
    });
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Desktop backend client disposed."));
    }
    this.pending.clear();

    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  async restart(): Promise<void> {
    this.dispose();
    await this.invoke("getHealth");
  }

  private ensureProcess(): UtilityProcess {
    if (this.process?.pid) {
      return this.process;
    }

    const child = utilityProcess.fork(this.backendModulePath);
    child.on("message", (message) => {
      this.handleMessage(message as DesktopBackendResponse);
    });
    child.on("exit", (code) => {
      const error = new Error(`Desktop backend exited with code ${code}.`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
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

    this.pending.delete(message.id);
    if (message.kind === "success") {
      pending.resolve(message.result);
      return;
    }

    pending.reject(new Error(message.error));
  }
}

function resolveDefaultBackendModulePath(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  return path.join(path.dirname(currentFilePath), "backend.js");
}
