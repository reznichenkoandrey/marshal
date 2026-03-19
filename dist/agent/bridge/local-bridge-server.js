import http from "node:http";
import { randomUUID } from "node:crypto";
export class LocalBridgeServer {
    server = null;
    port;
    queue = [];
    pendingResults = new Map();
    clients = new Map();
    constructor(port = Number(process.env.CHATGPT_EXTENSION_BRIDGE_PORT ?? "3210")) {
        this.port = port;
    }
    async start() {
        if (this.server) {
            return;
        }
        this.server = http.createServer(async (request, response) => {
            try {
                await this.handleRequest(request, response);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Unknown bridge server error.";
                writeJson(response, 500, { ok: false, error: message });
            }
        });
        await new Promise((resolve, reject) => {
            this.server?.listen(this.port, "127.0.0.1", () => resolve());
            this.server?.once("error", reject);
        });
    }
    async close() {
        for (const pending of this.pendingResults.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("Bridge server closed before command completed."));
        }
        this.pendingResults.clear();
        this.queue = [];
        this.clients.clear();
        if (!this.server) {
            return;
        }
        await new Promise((resolve, reject) => {
            this.server?.close((error) => (error ? reject(error) : resolve()));
        });
        this.server = null;
    }
    async waitForClient(timeoutMs = 60_000) {
        return this.waitForMatchingClient(timeoutMs);
    }
    async waitForReadyClient(timeoutMs = 60_000) {
        return this.waitForMatchingClient(timeoutMs, (client) => client.state === "ready");
    }
    getHealth() {
        const client = this.getPreferredClient();
        return {
            port: this.port,
            client,
            clientCount: this.clients.size,
            queueSize: this.queue.length
        };
    }
    async sendCommand(kind, payload, timeoutMs = 90_000) {
        const targetClient = await this.waitForReadyClient();
        const command = {
            id: randomUUID(),
            kind,
            payload,
            targetSessionKey: targetClient.sessionKey
        };
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingResults.delete(command.id);
                reject(new Error(`Timed out waiting for extension result: ${kind}`));
            }, timeoutMs);
            this.pendingResults.set(command.id, {
                resolve,
                reject,
                timeout,
                targetSessionKey: command.targetSessionKey
            });
            this.queue.push(command);
        });
    }
    async waitForMatchingClient(timeoutMs, predicate) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            const client = this.getPreferredClient(predicate);
            if (client) {
                return client;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error("No Chrome extension client connected. Load the unpacked extension from dist/chrome-extension and keep a ChatGPT tab open.");
    }
    async handleRequest(request, response) {
        setCorsHeaders(response);
        if (request.method === "OPTIONS") {
            response.writeHead(204);
            response.end();
            return;
        }
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.port}`);
        if (request.method === "GET" && url.pathname === "/health") {
            writeJson(response, 200, { ok: true, data: this.getHealth() });
            return;
        }
        if (request.method === "POST" && url.pathname === "/session/hello") {
            const body = await readJsonBody(request);
            const tabId = typeof body.tabId === "number" ? body.tabId : null;
            const clientId = String(body.clientId ?? "");
            const sessionKey = getSessionKey(clientId, tabId);
            this.clients.set(sessionKey, {
                clientId,
                url: String(body.url ?? ""),
                title: String(body.title ?? ""),
                tabId,
                state: String(body.state ?? "unknown"),
                sessionKey,
                updatedAt: Date.now()
            });
            this.pruneStaleClients();
            writeJson(response, 200, { ok: true });
            return;
        }
        if (request.method === "GET" && url.pathname === "/command/next") {
            const clientId = url.searchParams.get("clientId") ?? "";
            const tabId = parseTabId(url.searchParams.get("tabId"));
            const sessionKey = getSessionKey(clientId, tabId);
            const client = this.clients.get(sessionKey);
            if (!client || !isFreshClient(client)) {
                writeJson(response, 200, { ok: true, command: null });
                return;
            }
            const commandIndex = this.queue.findIndex((entry) => entry.targetSessionKey === sessionKey);
            const command = commandIndex >= 0 ? this.queue.splice(commandIndex, 1)[0] : null;
            writeJson(response, 200, { ok: true, command });
            return;
        }
        if (request.method === "POST" && url.pathname === "/command/result") {
            const body = await readJsonBody(request);
            const commandId = String(body.commandId ?? "");
            const pending = this.pendingResults.get(commandId);
            if (!pending) {
                writeJson(response, 404, { ok: false, error: `Unknown command id: ${commandId}` });
                return;
            }
            const sessionKey = getSessionKey(String(body.clientId ?? ""), typeof body.tabId === "number" ? body.tabId : null);
            if (sessionKey !== pending.targetSessionKey) {
                writeJson(response, 409, { ok: false, error: `Command ${commandId} returned from the wrong tab.` });
                return;
            }
            clearTimeout(pending.timeout);
            this.pendingResults.delete(commandId);
            pending.resolve({
                ok: Boolean(body.ok),
                data: isRecord(body.data) ? body.data : undefined,
                error: typeof body.error === "string" ? body.error : undefined
            });
            writeJson(response, 200, { ok: true });
            return;
        }
        writeJson(response, 404, { ok: false, error: `Unsupported bridge route: ${request.method} ${url.pathname}` });
    }
    getPreferredClient(predicate) {
        this.pruneStaleClients();
        const candidates = [...this.clients.values()]
            .filter((client) => isFreshClient(client))
            .filter((client) => isChatGPTUrl(client.url))
            .filter((client) => (predicate ? predicate(client) : true))
            .sort((left, right) => right.updatedAt - left.updatedAt);
        return candidates[0] ?? null;
    }
    pruneStaleClients() {
        for (const [sessionKey, client] of this.clients.entries()) {
            if (!isFreshClient(client)) {
                this.clients.delete(sessionKey);
            }
        }
    }
}
const sharedServers = new Map();
export function getSharedLocalBridgeServer(port = Number(process.env.CHATGPT_EXTENSION_BRIDGE_PORT ?? "3210")) {
    const existing = sharedServers.get(port);
    if (existing) {
        return existing;
    }
    const server = new LocalBridgeServer(port);
    sharedServers.set(port, server);
    return server;
}
function getSessionKey(clientId, tabId) {
    return `${clientId}:${tabId ?? "none"}`;
}
function parseTabId(value) {
    if (!value) {
        return null;
    }
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
}
function isFreshClient(client) {
    return Date.now() - client.updatedAt < 15_000;
}
function isChatGPTUrl(url) {
    return /https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url);
}
function setCorsHeaders(response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function writeJson(response, statusCode, payload) {
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
}
async function readJsonBody(request) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
        return {};
    }
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
