// Receives Claude Code hook events on loopback while Marshal runs and replays
// the ones the hook script spooled while it did not. Runs only while the hooks
// are installed; between events it is an idle socket, no timers (#281).

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { HOOK_SCRIPT_NAME } from "./hook-installer.ts";
import { buildHookScript, EventDeduper, eventKey, isFreshSpoolEntry, parseHookPayload, type HookEvent } from "./hook-events.ts";

export const HOOK_PATH = "/claude-code/hook";
export const ASSISTANT_PATH_PREFIX = "/assistant/";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export type HookRequest = {
  method: string | undefined;
  url: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  authorization: string | undefined;
};

/**
 * The voice dispatcher's helper (#318) talks to the same server: it streams
 * commands, lists sessions, speaks and runs Marshal's features. It answers
 * synchronously; `respond` owns `res` from then on.
 */
export interface AssistantRoutes {
  respond(method: string, route: string, body: string, res: http.ServerResponse): void;
}

/**
 * Status to refuse a request with, or null to accept it. Any Origin means a
 * browser sent it — the hook script never sets one — and a Host other than
 * our own loopback address means DNS rebinding; neither may inject events.
 */
export function rejectHookRequest(req: HookRequest, port: number, token: string, assistant = false): number | null {
  const isHook = req.method === "POST" && req.url === HOOK_PATH;
  const isAssistant = assistant && (req.method === "GET" || req.method === "POST") && req.url?.startsWith(ASSISTANT_PATH_PREFIX) === true;
  if (!isHook && !isAssistant) return 404;
  if (req.origin !== undefined) return 403;
  if (req.host !== `127.0.0.1:${port}`) return 403;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(req.authorization ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return 401;
  return null;
}

export class ClaudeHookService {
  private server: http.Server | null = null;
  private readonly deduper = new EventDeduper();
  private assistant: AssistantRoutes | null = null;

  constructor(
    private readonly hookDir: string,
    private readonly onEvent: (event: HookEvent) => void
  ) {}

  setAssistantRoutes(routes: AssistantRoutes | null): void {
    this.assistant = routes;
  }

  get scriptPath(): string {
    return path.join(this.hookDir, HOOK_SCRIPT_NAME);
  }

  /** Writes the hook script, so an install can point settings.json at it first. */
  writeScript(): string {
    fs.mkdirSync(this.hookDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.scriptPath, buildHookScript(this.hookDir), { mode: 0o700 });
    return this.scriptPath;
  }

  private starting: Promise<void> | null = null;

  /** Concurrent calls (app start and turning the assistant on) share one listen. */
  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.starting ??= this.listen().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async listen(): Promise<void> {
    this.writeScript();
    const token = randomBytes(32).toString("hex");
    const server = http.createServer((req, res) => this.handle(req, res, token));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    const { port } = server.address() as { port: number };
    fs.writeFileSync(path.join(this.hookDir, "auth-header"), `Authorization: Bearer ${token}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(this.hookDir, "port"), `${port}\n`, { mode: 0o600 });
    this.replaySpool();
  }

  stop(): void {
    for (const name of ["port", "auth-header"]) fs.rmSync(path.join(this.hookDir, name), { force: true });
    // The dispatcher's command stream never ends by itself.
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
  }

  /** Uninstall: nothing of Marshal's stays behind in userData either. */
  remove(): void {
    this.stop();
    fs.rmSync(this.hookDir, { recursive: true, force: true });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, token: string): void {
    const port = (this.server?.address() as { port: number } | null)?.port ?? 0;
    const status = rejectHookRequest({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
      authorization: req.headers.authorization
    }, port, token, this.assistant !== null);
    if (status !== null) {
      res.writeHead(status).end();
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.headersSent) return;
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url !== HOOK_PATH && this.assistant) {
        this.assistant.respond(req.method ?? "GET", req.url!.slice(ASSISTANT_PATH_PREFIX.length), body, res);
        return;
      }
      res.writeHead(204).end();
      this.accept(body);
    });
  }

  private accept(raw: string): void {
    const event = parseHookPayload(raw);
    if (!event || !this.deduper.accept(eventKey(event.sessionId, raw), Date.now())) return;
    try {
      this.onEvent(event);
    } catch (err) {
      console.warn("[claude-hooks] event handler failed:", err instanceof Error ? err.message : err);
    }
  }

  private replaySpool(): void {
    const spool = path.join(this.hookDir, "spool");
    let names: string[];
    try {
      names = fs.readdirSync(spool).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      const file = path.join(spool, name);
      try {
        const fresh = isFreshSpoolEntry(fs.statSync(file).mtimeMs, now);
        const raw = fs.readFileSync(file, "utf8");
        // Delete before handling: a crash mid-replay must not notify twice.
        fs.rmSync(file, { force: true });
        if (fresh) this.accept(raw);
      } catch (err) {
        console.warn("[claude-hooks] spool entry skipped:", err instanceof Error ? err.message : err);
      }
    }
  }
}
