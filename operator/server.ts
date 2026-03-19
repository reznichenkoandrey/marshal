import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { OperatorTaskService, normalizeRoute, sanitizeUploads } from "./task-service.ts";

const STATIC_DIR = path.resolve(process.cwd(), "operator", "static");

export class OperatorServer {
  port: number;
  service: OperatorTaskService;
  server: http.Server | null = null;

  constructor(port = Number(process.env.OPERATOR_WEB_PORT ?? "3489"), service = new OperatorTaskService()) {
    this.port = port;
    this.service = service;
  }

  async start(): Promise<void> {
    await this.service.initialize();
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
        data: await this.service.getHealth(this.port)
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/projects") {
      const projects = await this.service.listProjects();
      writeJson(response, 200, { ok: true, data: projects });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/projects") {
      const body = await readJsonBody(request);
      const project = await this.service.createProject(typeof body.name === "string" ? body.name : undefined);
      writeJson(response, 201, { ok: true, data: project });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const sessions = await this.service.listSessions(url.searchParams.get("projectId") ?? undefined);
      writeJson(response, 200, { ok: true, data: sessions });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJsonBody(request);
      const session = await this.service.createSession(
        typeof body.title === "string" ? body.title : undefined,
        typeof body.projectId === "string" ? body.projectId : undefined
      );
      writeJson(response, 201, { ok: true, data: session });
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (request.method === "GET" && sessionMatch) {
      const session = await this.service.readSession(sessionMatch[1], url.searchParams.get("projectId") ?? undefined);
      writeJson(response, 200, { ok: true, data: session });
      return;
    }

    if (request.method === "DELETE" && sessionMatch) {
      await this.service.deleteSession(sessionMatch[1], url.searchParams.get("projectId") ?? undefined);
      writeJson(response, 200, { ok: true });
      return;
    }

    const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (request.method === "POST" && messageMatch) {
      const sessionId = messageMatch[1];
      const body = await readJsonBody(request);
      const session = await this.service.submitTask({
        sessionId,
        projectId: url.searchParams.get("projectId") ?? undefined,
        text: String(body.text ?? ""),
        route: normalizeRoute(body.route),
        uploads: Array.isArray(body.attachments) ? sanitizeUploads(body.attachments) : []
      });
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
