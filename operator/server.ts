import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { runMarshalTask } from "../agent/runtime/marshal.ts";
import type { MarshalRuntimeEvent } from "../agent/runtime/types.ts";
import { OperatorSessionStore } from "./session-store.ts";
import type { ExecutionRoute } from "../agent/runtime/types.ts";
import type { UploadPayload } from "./types.ts";

const STATIC_DIR = path.resolve(process.cwd(), "operator", "static");

export class OperatorServer {
  port: number;
  store: OperatorSessionStore;
  server: http.Server | null = null;
  private queueTail = Promise.resolve();

  constructor(port = Number(process.env.OPERATOR_WEB_PORT ?? "3489"), store = new OperatorSessionStore()) {
    this.port = port;
    this.store = store;
  }

  async start(): Promise<void> {
    await this.store.initialize();
    if (this.server) {
      return;
    }

    this.server = http.createServer(async (request, response) => {
      try {
        await this.handleRequest(request, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown operator server error.";
        writeJson(response, 500, { ok: false, error: message });
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.listen(this.port, "127.0.0.1", () => resolve());
      this.server?.once("error", reject);
    });
  }

  async close(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.port}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      writeJson(response, 200, {
        ok: true,
        data: {
          port: this.port,
          queued: true
        }
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const sessions = await this.store.listSessions();
      writeJson(response, 200, { ok: true, data: sessions });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJsonBody(request);
      const session = await this.store.createSession(typeof body.title === "string" ? body.title : undefined);
      writeJson(response, 201, { ok: true, data: session });
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (request.method === "GET" && sessionMatch) {
      const session = await this.store.readSession(sessionMatch[1]);
      writeJson(response, 200, { ok: true, data: session });
      return;
    }

    const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (request.method === "POST" && messageMatch) {
      const sessionId = messageMatch[1];
      const body = await readJsonBody(request);
      const route = normalizeRoute(body.route);
      const uploads = Array.isArray(body.attachments) ? sanitizeUploads(body.attachments) : [];
      const task = await this.store.createTaskFromMessage({
        sessionId,
        text: String(body.text ?? ""),
        route,
        uploads
      });
      this.enqueueTask(sessionId, task.id);
      const session = await this.store.readSession(sessionId);
      writeJson(response, 202, { ok: true, data: session });
      return;
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/static/"))) {
      await this.serveStatic(url.pathname, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    writeJson(response, 404, {
      ok: false,
      error: `Unsupported route: ${request.method} ${url.pathname}`
    });
  }

  private enqueueTask(sessionId: string, taskId: string): void {
    this.queueTail = this.queueTail
      .then(() => this.runQueuedTask(sessionId, taskId))
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : "Unknown queue error.";
        await this.store.markTaskFailed(sessionId, taskId, message).catch(() => undefined);
      });
  }

  private async runQueuedTask(sessionId: string, taskId: string): Promise<void> {
    const session = await this.store.readSession(sessionId);
    const task = session.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      return;
    }

    const paths = this.store.getSessionPaths(sessionId);
    await this.store.markTaskRunning(sessionId, taskId);

    try {
      const result = await runMarshalTask({
        task: task.prompt,
        route: task.route,
        attachments: task.attachments,
        workspaceRoot: paths.workspaceDir,
        memoryDir: paths.memoryDir,
        onEvent: async (event) => {
          await this.store.appendTaskEvent(sessionId, taskId, event.type, formatRuntimeEvent(event));
        }
      });
      await this.store.markTaskCompleted(sessionId, taskId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown task failure.";
      await this.store.markTaskFailed(sessionId, taskId, message);
    }
  }

  private async serveStatic(requestPath: string, response: http.ServerResponse): Promise<void> {
    const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/static\//, "");
    const filePath = path.resolve(STATIC_DIR, relativePath);
    if (!filePath.startsWith(`${STATIC_DIR}${path.sep}`) && filePath !== STATIC_DIR) {
      writeJson(response, 403, { ok: false, error: "Static path escapes operator UI directory." });
      return;
    }

    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "cache-control": "no-store"
    });
    response.end(content);
  }
}

function normalizeRoute(value: unknown): ExecutionRoute {
  return value === "local" || value === "browser" ? value : "auto";
}

function sanitizeUploads(value: unknown[]): UploadPayload[] {
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      name: String(item.name ?? "upload.bin"),
      mimeType: String(item.mimeType ?? "application/octet-stream"),
      contentBase64: String(item.contentBase64 ?? "")
    }))
    .filter((item) => item.contentBase64.length > 0);
}

function formatRuntimeEvent(event: MarshalRuntimeEvent): string {
  switch (event.type) {
    case "task_started":
      return `Task started with route ${event.route}. Workspace: ${event.workspaceRoot}`;
    case "planning_started":
      return `Planning started for route ${event.route}.`;
    case "plan_ready":
      return `Plan ready: ${event.steps.join(" -> ")}`;
    case "step_started":
      return `Step ${event.stepIndex + 1}/${event.totalSteps}: ${event.step} (iteration ${event.iteration})`;
    case "action_requested":
      return `Action ${event.action}: ${event.thought}`;
    case "tool_completed":
      return `Tool ${event.action} completed: ${event.summary}`;
    case "tool_failed":
      return `Tool ${event.action} failed: ${event.error}`;
    case "step_completed":
      return `Step ${event.stepIndex + 1}/${event.totalSteps} complete: ${event.summary}`;
    case "task_completed":
      return `Task completed: ${event.result}`;
    case "task_failed":
      return `Task failed: ${event.error}`;
    default:
      return "Runtime event recorded.";
  }
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object body.");
  }

  return parsed as Record<string, unknown>;
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  return "application/octet-stream";
}
