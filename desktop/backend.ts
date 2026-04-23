import path from "node:path";
import { fileURLToPath } from "node:url";
import "electron";

import { config as loadDotenv } from "dotenv";

import { OperatorTaskService } from "../operator/task-service.ts";
import type { DesktopBackendMethod, DesktopBackendRequest, DesktopBackendResponse } from "./backend-types.ts";

// Load .env from project root. Utility process has its own env — make sure it
// sees MARSHAL_* keys. `override: false` preserves parent-provided values.
const backendFilePath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(backendFilePath), "..", "..");
loadDotenv({ path: path.join(projectRoot, ".env"), override: false });

const service = new OperatorTaskService();
const parentPort = process.parentPort;

if (!parentPort) {
  throw new Error("Marshal desktop backend must run inside an Electron utility process.");
}

const handlers: Record<DesktopBackendMethod, (...params: unknown[]) => Promise<unknown>> = {
  getHealth: async () => service.getHealth(),
  listProjects: async () => service.listProjects(),
  createProject: async (name?: unknown) => service.createProject(typeof name === "string" ? name : undefined),
  listSessions: async (projectId?: unknown) => service.listSessions(typeof projectId === "string" ? projectId : undefined),
  createSession: async (input?: unknown) => {
    const payload = isObject(input) ? input : {};
    return service.createSession(asOptionalString(payload.title), asOptionalString(payload.projectId));
  },
  readSession: async (input?: unknown) => {
    const payload = expectObject(input);
    return service.readSession(asRequiredString(payload.sessionId, "sessionId"), asOptionalString(payload.projectId));
  },
  deleteSession: async (input?: unknown) => {
    const payload = expectObject(input);
    await service.deleteSession(asRequiredString(payload.sessionId, "sessionId"), asOptionalString(payload.projectId));
    return null;
  },
  submitTask: async (input?: unknown) => {
    const payload = expectObject(input);
    return service.submitTask({
      sessionId: asRequiredString(payload.sessionId, "sessionId"),
      projectId: asOptionalString(payload.projectId),
      text: asRequiredString(payload.text, "text"),
      route: payload.route === "local" || payload.route === "browser" ? payload.route : "auto",
      uploads: Array.isArray(payload.uploads) ? (payload.uploads as never[]) : [],
      workingDir: asOptionalString(payload.workingDir)
    });
  },
  getSessionPaths: async (input?: unknown) => {
    const payload = expectObject(input);
    return service.getSessionPaths(asRequiredString(payload.sessionId, "sessionId"), asOptionalString(payload.projectId));
  }
};

void bootstrap();

async function bootstrap(): Promise<void> {
  await service.initialize();

  // Signal readiness so the parent client can unblock pending invokes.
  parentPort.postMessage({ kind: "ready" });

  parentPort.on("message", async (event) => {
    const message = event.data as DesktopBackendRequest;
    if (!message || message.kind !== "invoke") {
      return;
    }

    const response = await handleRequest(message);
    parentPort.postMessage(response);
  });
}

async function handleRequest(message: DesktopBackendRequest): Promise<DesktopBackendResponse> {
  try {
    const handler = handlers[message.method];
    if (!handler) {
      throw new Error(`Unsupported backend method: ${message.method}`);
    }

    const result = await handler(...message.params);
    return {
      kind: "success",
      id: message.id,
      result
    };
  } catch (error) {
    return {
      kind: "failure",
      id: message.id,
      error: error instanceof Error ? error.message : "Unknown desktop backend error."
    };
  }
}

function expectObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error("Expected an object payload.");
  }

  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected a non-empty string for ${fieldName}.`);
  }

  return value;
}
