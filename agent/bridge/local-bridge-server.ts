import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { ClaudeApiBridge } from "./claude-api-bridge.ts";
import { ClaudeCliBridge } from "./claude-cli-bridge.ts";
import { ClaudeWebBridge } from "./claude-web-bridge.ts";
import { CodexCliBridge } from "./codex-cli-bridge.ts";
import { OpenAiApiBridge } from "./openai-api-bridge.ts";
import { ChatGPTBridge as PlaywrightChatGPTBridge } from "./chatgpt.ts";
import type { ReasoningBridge } from "./types.ts";

export const CHAT_PROVIDERS = [
  "claude-cli",   // Claude via desktop subscription (claude auth)
  "codex-cli",    // ChatGPT via desktop subscription (codex login)
  "claude",       // Anthropic Messages API (needs ANTHROPIC_API_KEY)
  "api",          // OpenAI-compatible API (Groq/OpenRouter) — MARSHAL_API_KEY
  "claude-web",   // Claude web via Playwright
  "playwright"    // ChatGPT web via Playwright
] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

function createBridgeForProvider(provider: ChatProvider): ReasoningBridge {
  switch (provider) {
    case "claude-cli":   return new ClaudeCliBridge();
    case "codex-cli":    return new CodexCliBridge();
    case "claude":       return new ClaudeApiBridge();
    case "api":          return new OpenAiApiBridge();
    case "claude-web":   return new ClaudeWebBridge();
    case "playwright":   return new PlaywrightChatGPTBridge();
  }
}

function normalizeProvider(value: unknown): ChatProvider {
  return typeof value === "string" && (CHAT_PROVIDERS as readonly string[]).includes(value)
    ? (value as ChatProvider)
    : "claude-cli";
}

export type ExtensionState = {
  clientId: string;
  url: string;
  title: string;
  tabId: number | null;
  state: string;
  visibilityState: string;
  hasFocus: boolean;
  activeTab: boolean;
  sessionKey: string;
  updatedAt: number;
};

export type BridgeCommandKind = "send_prompt" | "reset_conversation" | "debug_snapshot";

type BridgeCommand = {
  id: string;
  kind: BridgeCommandKind;
  payload: Record<string, unknown>;
  targetSessionKey: string;
};

type PendingResult = {
  resolve: (value: { ok: boolean; data?: Record<string, unknown>; error?: string }) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  targetSessionKey: string;
};

export class LocalBridgeServer {
  server: http.Server | null = null;
  port: number;
  queue: BridgeCommand[] = [];
  pendingResults = new Map<string, PendingResult>();
  clients = new Map<string, ExtensionState>();
  // Per-session Claude CLI bridges for the /chat endpoint used by the
  // Chrome side-panel. Each session keeps its own conversation id so the
  // user can have independent threads across tabs.
  private chatBridges = new Map<string, ReasoningBridge>();

  constructor(port = Number(process.env.CHATGPT_EXTENSION_BRIDGE_PORT ?? "3210")) {
    this.port = port;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer(async (request, response) => {
      try {
        await this.handleRequest(request, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown bridge server error.";
        writeJson(response, 500, { ok: false, error: message });
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.listen(this.port, "127.0.0.1", () => resolve());
      this.server?.once("error", reject);
    });
  }

  async close(): Promise<void> {
    for (const pending of this.pendingResults.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Bridge server closed before command completed."));
    }

    this.pendingResults.clear();
    this.queue = [];
    this.clients.clear();

    for (const bridge of this.chatBridges.values()) {
      await bridge.close().catch(() => undefined);
    }
    this.chatBridges.clear();

    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });

    this.server = null;
  }

  async waitForClient(timeoutMs = 60_000): Promise<ExtensionState> {
    return this.waitForMatchingClient(timeoutMs);
  }

  async waitForReadyClient(timeoutMs = 60_000): Promise<ExtensionState> {
    return this.waitForMatchingClient(timeoutMs, (client) => client.state === "ready");
  }

  async waitForReadySessionClient(sessionKey: string, timeoutMs = 60_000): Promise<ExtensionState> {
    return this.waitForMatchingClient(
      timeoutMs,
      (client) => client.sessionKey === sessionKey && client.state === "ready"
    );
  }

  getHealth(): {
    port: number;
    client: ExtensionState | null;
    clientCount: number;
    queueSize: number;
  } {
    const client = this.getPreferredClient();
    return {
      port: this.port,
      client,
      clientCount: this.clients.size,
      queueSize: this.queue.length
    };
  }

  async sendCommand(
    kind: BridgeCommandKind,
    payload: Record<string, unknown>,
    timeoutMs = 90_000,
    preferredSessionKey?: string | null
  ): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
    const targetClient = preferredSessionKey
      ? await this.waitForReadySessionClient(preferredSessionKey)
      : await this.waitForReadyClient();

    const command: BridgeCommand = {
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

  private async waitForMatchingClient(
    timeoutMs: number,
    predicate?: (client: ExtensionState) => boolean
  ): Promise<ExtensionState> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const client = this.getPreferredClient(predicate);
      if (client) {
        return client;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
      "No Chrome extension client connected. Load the unpacked extension from dist/chrome-extension and keep a ChatGPT tab open."
    );
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
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

    if (request.method === "POST" && url.pathname === "/chat") {
      await this.handleChatRequest(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/chat/reset") {
      const body = await readJsonBody(request);
      const sessionId = String(body.sessionId ?? "default");
      // Reset every cached provider session for this panel, not just the
      // currently-selected one — the panel's "new conversation" button
      // should wipe history across every backend the user tried.
      for (const [key, bridge] of this.chatBridges.entries()) {
        if (key.startsWith(`${sessionId}::`)) {
          await bridge.close().catch(() => undefined);
          this.chatBridges.delete(key);
        }
      }
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/chat/providers") {
      writeJson(response, 200, { ok: true, data: { providers: CHAT_PROVIDERS } });
      return;
    }

    if (request.method === "POST" && url.pathname === "/capture/fullpage") {
      await handleFullPageCapture(request, response);
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
        visibilityState: String(body.visibilityState ?? "hidden"),
        hasFocus: Boolean(body.hasFocus),
        activeTab: Boolean(body.activeTab),
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

      const sessionKey = getSessionKey(
        String(body.clientId ?? ""),
        typeof body.tabId === "number" ? body.tabId : null
      );
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

  private async handleChatRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
      writeJson(response, 400, { ok: false, error: "prompt is required" });
      return;
    }

    const sessionId = String(body.sessionId ?? "default");
    const provider = normalizeProvider(body.provider);
    // Each provider keeps an independent conversation — switching provider
    // should NOT resume a session started on a different backend.
    const cacheKey = `${sessionId}::${provider}`;
    const context = typeof body.context === "string" ? body.context : "";
    const customSystemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt : null;
    const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;

    let bridge = this.chatBridges.get(cacheKey);
    if (!bridge) {
      bridge = createBridgeForProvider(provider);
      try {
        await bridge.initialize();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bridge initialization failed.";
        writeJson(response, 500, { ok: false, error: `${provider}: ${message}` });
        return;
      }
      await bridge.prime(customSystemPrompt ?? DEFAULT_BROWSER_SYSTEM_PROMPT);
      this.chatBridges.set(cacheKey, bridge);
    }

    try {
      const text = await bridge.ask(fullPrompt);
      writeJson(response, 200, { ok: true, data: { text, sessionId, provider } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bridge request failed.";
      writeJson(response, 500, { ok: false, error: `${provider}: ${message}` });
    }
  }

  private getPreferredClient(predicate?: (client: ExtensionState) => boolean): ExtensionState | null {
    this.pruneStaleClients();

    const candidates = [...this.clients.values()]
      .filter((client) => isFreshClient(client))
      .filter((client) => isChatGPTUrl(client.url))
      .filter((client) => (predicate ? predicate(client) : true))
      .sort(compareClientsForRouting);

    return candidates[0] ?? null;
  }

  private pruneStaleClients(): void {
    for (const [sessionKey, client] of this.clients.entries()) {
      if (!isFreshClient(client)) {
        this.clients.delete(sessionKey);
      }
    }
  }
}

const DEFAULT_BROWSER_SYSTEM_PROMPT = [
  "You are Claude, running inside a browser side-panel extension called Marshal.",
  "The user is browsing the web. For every turn you will be given the current page URL and title,",
  "and optionally a picked element's text or HTML that the user selected.",
  "Answer in the user's language (match the question's language — usually Ukrainian or English).",
  "Keep replies concise and practical. Do not assume you have access to file-system tools or a repo;",
  "this is a browser chat, not a coding session."
].join(" ");

const sharedServers = new Map<number, LocalBridgeServer>();

export function getSharedLocalBridgeServer(port = Number(process.env.CHATGPT_EXTENSION_BRIDGE_PORT ?? "3210")): LocalBridgeServer {
  const existing = sharedServers.get(port);
  if (existing) {
    return existing;
  }

  const server = new LocalBridgeServer(port);
  sharedServers.set(port, server);
  return server;
}

function getSessionKey(clientId: string, tabId: number | null): string {
  return `${clientId}:${tabId ?? "none"}`;
}

function parseTabId(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function isFreshClient(client: ExtensionState): boolean {
  return Date.now() - client.updatedAt < 15_000;
}

function compareClientsForRouting(left: ExtensionState, right: ExtensionState): number {
  return (
    compareBooleans(right.activeTab, left.activeTab) ||
    compareVisibility(right.visibilityState, left.visibilityState) ||
    compareBooleans(right.hasFocus, left.hasFocus) ||
    right.updatedAt - left.updatedAt
  );
}

function compareBooleans(left: boolean, right: boolean): number {
  return Number(left) - Number(right);
}

function compareVisibility(left: string, right: string): number {
  return Number(left === "visible") - Number(right === "visible");
}

function isChatGPTUrl(url: string): boolean {
  return /https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url);
}

function setCorsHeaders(response: http.ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: object): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Persist a full-page PNG sent by the Chrome extension into the user's
 * configured capture folder. Refuses unreasonably large payloads so a
 * malicious or buggy page cannot exhaust disk space.
 */
async function handleFullPageCapture(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  // 60 MB upper bound on the base64 payload — empirically more than enough
  // for a 4K full-page screenshot; ~45 MB raw PNG decoded.
  const MAX_PAYLOAD_BYTES = 60 * 1024 * 1024;
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    writeJson(response, 413, { ok: false, error: "Capture payload too large" });
    return;
  }

  const body = await readJsonBody(request);
  const base64 = typeof body.base64 === "string" ? body.base64 : "";
  if (!base64) {
    writeJson(response, 400, { ok: false, error: "Missing base64 payload" });
    return;
  }

  const url = typeof body.url === "string" ? body.url : "";
  const title = typeof body.title === "string" ? body.title : "";
  const capturedAt = typeof body.capturedAt === "number" ? body.capturedAt : Date.now();

  const folder = process.env.MARSHAL_CAPTURE_FOLDER?.trim() || path.join(os.homedir(), "Desktop");
  try {
    await fs.promises.mkdir(folder, { recursive: true });
  } catch (err) {
    writeJson(response, 500, { ok: false, error: `Cannot create capture folder: ${(err as Error).message}` });
    return;
  }

  const filename = buildFullPageFilename(url, title, capturedAt);
  const filePath = path.join(folder, filename);

  // Strip any `data:image/png;base64,` prefix that an over-eager client might
  // include. We expect raw base64 from the debugger, but be tolerant.
  const stripped = base64.replace(/^data:image\/[^;]+;base64,/u, "");
  let buffer: Buffer;
  try {
    buffer = Buffer.from(stripped, "base64");
  } catch (err) {
    writeJson(response, 400, { ok: false, error: `Invalid base64: ${(err as Error).message}` });
    return;
  }

  try {
    await fs.promises.writeFile(filePath, buffer);
  } catch (err) {
    writeJson(response, 500, { ok: false, error: `Cannot write capture: ${(err as Error).message}` });
    return;
  }

  writeJson(response, 200, {
    ok: true,
    savedPath: filePath,
    bytes: buffer.byteLength,
    filename
  });
}

function buildFullPageFilename(url: string, title: string, capturedAt: number): string {
  const d = new Date(capturedAt);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;

  // Prefer the page title for human readability; fall back to the host name
  // when the title is empty (PDF viewer tabs, etc.). Sanitize anything that
  // would be a path separator or shell metacharacter.
  let label = title.trim() || hostname(url) || "Web page";
  label = label.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
  if (label.length > 60) label = label.slice(0, 60).trim();

  return `Marshal ${ts} ${label} (full page).png`;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
