import path from "node:path";
import { fileURLToPath } from "node:url";
import { utilityProcess } from "electron";
export class DesktopBackendClient {
    backendModulePath;
    process = null;
    requestCounter = 0;
    pending = new Map();
    constructor(backendModulePath = resolveDefaultBackendModulePath()) {
        this.backendModulePath = backendModulePath;
    }
    async invoke(method, ...params) {
        const process = this.ensureProcess();
        const requestId = `${Date.now()}-${this.requestCounter++}`;
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, {
                resolve: (value) => resolve(value),
                reject
            });
            const request = {
                kind: "invoke",
                id: requestId,
                method,
                params
            };
            process.postMessage(request);
        });
    }
    dispose() {
        for (const pending of this.pending.values()) {
            pending.reject(new Error("Desktop backend client disposed."));
        }
        this.pending.clear();
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }
    async restart() {
        this.dispose();
        await this.invoke("getHealth");
    }
    ensureProcess() {
        if (this.process?.pid) {
            return this.process;
        }
        const child = utilityProcess.fork(this.backendModulePath);
        child.on("message", (message) => {
            this.handleMessage(message);
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
    handleMessage(message) {
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
function resolveDefaultBackendModulePath() {
    const currentFilePath = fileURLToPath(import.meta.url);
    return path.join(path.dirname(currentFilePath), "backend.js");
}
