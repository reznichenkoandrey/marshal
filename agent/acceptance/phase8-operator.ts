import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { OperatorServer } from "../../operator/server.ts";
import { OperatorTaskService } from "../../operator/task-service.ts";
import { OperatorSessionStore } from "../../operator/session-store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const DATA_DIR = path.resolve(PROJECT_ROOT, "agent/workspace/phase8-acceptance/operator-data");
const TEST_PORT = 19822;

async function httpJson(port: number, method: string, urlPath: string, body?: Record<string, unknown>): Promise<{
  status: number;
  data: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : undefined
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            reject(new Error(`Non-JSON response: ${raw}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Test: full operator API cycle with file attachment
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Phase 8: Operator Web Console Acceptance ===\n");

  await fs.rm(DATA_DIR, { recursive: true, force: true });

  const store = new OperatorSessionStore(DATA_DIR);
  const service = new OperatorTaskService(store);
  const server = new OperatorServer(TEST_PORT, service);

  await server.start();

  try {
    // 1. Health check
    process.stdout.write("  Health check ... ");
    const health = await httpJson(TEST_PORT, "GET", "/api/health");
    assert(health.status === 200, `Expected 200, got ${health.status}`);
    assert((health.data as { ok: boolean }).ok === true, "Health check not ok");
    console.log("OK");

    // 2. Create session
    process.stdout.write("  Create session ... ");
    const sessionRes = await httpJson(TEST_PORT, "POST", "/api/sessions", { title: "Phase 8 acceptance" });
    assert(sessionRes.status === 201, `Expected 201, got ${sessionRes.status}`);
    const session = (sessionRes.data as { data: { id: string } }).data;
    assert(typeof session.id === "string" && session.id.length > 0, "Session id empty");
    console.log(`OK (${session.id})`);

    // 3. Submit task with attachment
    process.stdout.write("  Submit task with attachment ... ");
    const fileContent = "phase8 acceptance content";
    const fileBase64 = Buffer.from(fileContent).toString("base64");
    const submitRes = await httpJson(TEST_PORT, "POST", `/api/sessions/${session.id}/messages`, {
      text: "Process the uploaded file and confirm its content.",
      route: "local",
      attachments: [
        { name: "input.txt", mimeType: "text/plain", contentBase64: fileBase64 }
      ]
    });
    assert(submitRes.status === 202, `Expected 202, got ${submitRes.status}`);
    console.log("OK");

    // 4. Verify attachment was persisted to uploads dir
    process.stdout.write("  Verify attachment file ... ");
    const sessionPaths = await service.getSessionPaths(session.id);
    const uploadedFiles = await fs.readdir(sessionPaths.uploadsDir).catch(() => [] as string[]);
    assert(uploadedFiles.some((f) => f.includes("input.txt")), `Uploaded file not found in ${sessionPaths.uploadsDir}`);

    const uploadedFilePath = path.join(sessionPaths.uploadsDir, uploadedFiles.find((f) => f.includes("input.txt"))!);
    const uploadedContent = await fs.readFile(uploadedFilePath, "utf8");
    assert(uploadedContent === fileContent, `Uploaded content mismatch: "${uploadedContent}"`);
    console.log("OK");

    // 5. Read session back — should have at least one task
    process.stdout.write("  Read session back ... ");
    const readRes = await httpJson(TEST_PORT, "GET", `/api/sessions/${session.id}`);
    assert(readRes.status === 200, `Expected 200, got ${readRes.status}`);
    const readSession = (readRes.data as { data: { id: string; tasks: unknown[] } }).data;
    assert(readSession.tasks.length > 0, "Session has no tasks");
    console.log("OK");

    // 6. List sessions — at least the one we created
    process.stdout.write("  List sessions ... ");
    const listRes = await httpJson(TEST_PORT, "GET", "/api/sessions");
    assert(listRes.status === 200, `Expected 200, got ${listRes.status}`);
    const sessions = (listRes.data as { data: unknown[] }).data;
    assert(sessions.length > 0, "No sessions in list");
    console.log("OK");

    // 7. Verify task was enqueued with correct attachment metadata
    process.stdout.write("  Verify task has attachment metadata ... ");
    const taskSession = (readRes.data as { data: { tasks: { attachments?: { name: string }[] }[] } }).data;
    const task = taskSession.tasks[0];
    assert(
      Array.isArray(task.attachments) && task.attachments.some((a) => a.name.includes("input.txt")),
      "Task attachment metadata missing"
    );
    console.log("OK");

    // Note: delete requires task to settle, which needs a live bridge.
    // Task execution correctness is validated in Phase 6.
    // API contract for delete is covered by the store implementation.

    console.log("\nAll Phase 8 operator acceptance checks passed.");
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
