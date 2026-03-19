import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getDefaultSessionMemory, getDefaultSessionWorkspace } from "../agent/runtime/marshal.js";
export class OperatorSessionStore {
    baseDir;
    sessionLocks = new Map();
    constructor(baseDir = path.resolve(process.cwd(), "operator-data", "sessions")) {
        this.baseDir = baseDir;
    }
    async initialize() {
        await fs.mkdir(this.baseDir, { recursive: true });
    }
    async listSessions() {
        await this.initialize();
        const dirents = await fs.readdir(this.baseDir, { withFileTypes: true });
        const sessions = await Promise.all(dirents
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => this.readSession(entry.name).catch(() => null)));
        return sessions
            .filter((session) => session !== null)
            .map((session) => {
            const activeTask = session.tasks.find((task) => task.id === session.activeTaskId) ?? null;
            return {
                id: session.id,
                title: session.title,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                activeTaskId: session.activeTaskId,
                activeTaskStatus: activeTask?.status ?? null,
                messageCount: session.messages.length
            };
        })
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    async createSession(title) {
        await this.initialize();
        const id = randomUUID();
        const now = new Date().toISOString();
        const session = {
            id,
            title: title?.trim() || "New operator session",
            createdAt: now,
            updatedAt: now,
            activeTaskId: null,
            messages: [
                {
                    id: randomUUID(),
                    role: "system",
                    text: "Operator session created.",
                    createdAt: now,
                    route: null,
                    taskId: null,
                    attachments: []
                }
            ],
            tasks: []
        };
        const paths = this.getSessionPaths(id);
        await fs.mkdir(paths.dir, { recursive: true });
        await fs.mkdir(paths.workspaceDir, { recursive: true });
        await fs.mkdir(paths.memoryDir, { recursive: true });
        await this.writeSession(session);
        return session;
    }
    async readSession(sessionId) {
        const raw = await fs.readFile(this.getSessionPaths(sessionId).filePath, "utf8");
        return JSON.parse(raw);
    }
    async createTaskFromMessage(input) {
        const trimmedText = input.text.trim();
        if (!trimmedText) {
            throw new Error("Task text is required.");
        }
        return this.withSessionLock(input.sessionId, async () => {
            const session = await this.readSession(input.sessionId);
            const attachments = await this.saveUploads(input.sessionId, input.uploads);
            const now = new Date().toISOString();
            const taskId = randomUUID();
            const task = {
                id: taskId,
                prompt: trimmedText,
                route: input.route,
                attachments,
                createdAt: now,
                startedAt: null,
                finishedAt: null,
                status: "queued",
                result: null,
                error: null,
                events: [
                    {
                        id: randomUUID(),
                        createdAt: now,
                        type: "queued",
                        detail: `Task queued with route ${input.route}.`
                    }
                ]
            };
            const message = {
                id: randomUUID(),
                role: "user",
                text: trimmedText,
                createdAt: now,
                route: input.route,
                taskId,
                attachments
            };
            session.tasks.push(task);
            session.messages.push(message);
            session.activeTaskId = taskId;
            session.updatedAt = now;
            if (session.title === "New operator session") {
                session.title = trimmedText.slice(0, 60);
            }
            await this.writeSession(session);
            return task;
        });
    }
    async markTaskRunning(sessionId, taskId) {
        await this.mutateSession(sessionId, (session) => {
            const task = findTask(session, taskId);
            const now = new Date().toISOString();
            task.status = "running";
            task.startedAt = now;
            task.events.push({
                id: randomUUID(),
                createdAt: now,
                type: "running",
                detail: "Task execution started."
            });
            session.activeTaskId = taskId;
            session.updatedAt = now;
        });
    }
    async appendTaskEvent(sessionId, taskId, type, detail) {
        await this.mutateSession(sessionId, (session) => {
            const task = findTask(session, taskId);
            const now = new Date().toISOString();
            task.events.push({
                id: randomUUID(),
                createdAt: now,
                type,
                detail
            });
            session.updatedAt = now;
        });
    }
    async markTaskCompleted(sessionId, taskId, result) {
        await this.mutateSession(sessionId, (session) => {
            const task = findTask(session, taskId);
            const now = new Date().toISOString();
            task.status = "completed";
            task.finishedAt = now;
            task.result = result;
            task.events.push({
                id: randomUUID(),
                createdAt: now,
                type: "completed",
                detail: "Task completed successfully."
            });
            session.messages.push({
                id: randomUUID(),
                role: "assistant",
                text: result,
                createdAt: now,
                route: task.route,
                taskId: task.id,
                attachments: []
            });
            session.activeTaskId = null;
            session.updatedAt = now;
        });
    }
    async markTaskFailed(sessionId, taskId, error) {
        await this.mutateSession(sessionId, (session) => {
            const task = findTask(session, taskId);
            const now = new Date().toISOString();
            task.status = "failed";
            task.finishedAt = now;
            task.error = error;
            task.events.push({
                id: randomUUID(),
                createdAt: now,
                type: "failed",
                detail: error
            });
            session.messages.push({
                id: randomUUID(),
                role: "assistant",
                text: `Task failed: ${error}`,
                createdAt: now,
                route: task.route,
                taskId: task.id,
                attachments: []
            });
            session.activeTaskId = null;
            session.updatedAt = now;
        });
    }
    getSessionPaths(sessionId) {
        const dir = path.join(this.baseDir, sessionId);
        return {
            dir,
            filePath: path.join(dir, "session.json"),
            workspaceDir: getDefaultSessionWorkspace(sessionId),
            memoryDir: getDefaultSessionMemory(sessionId),
            uploadsDir: path.join(getDefaultSessionWorkspace(sessionId), "uploads")
        };
    }
    async saveUploads(sessionId, uploads) {
        if (uploads.length === 0) {
            return [];
        }
        const paths = this.getSessionPaths(sessionId);
        await fs.mkdir(paths.uploadsDir, { recursive: true });
        return Promise.all(uploads.map(async (upload) => {
            const attachmentId = randomUUID();
            const safeName = sanitizeFilename(upload.name || "upload.bin");
            const fileName = `${attachmentId}-${safeName}`;
            const absolutePath = path.join(paths.uploadsDir, fileName);
            const buffer = Buffer.from(upload.contentBase64, "base64");
            await fs.writeFile(absolutePath, buffer);
            return {
                id: attachmentId,
                name: upload.name || safeName,
                mimeType: upload.mimeType || "application/octet-stream",
                size: buffer.byteLength,
                relativePath: path.relative(paths.workspaceDir, absolutePath),
                absolutePath,
                uploadedAt: new Date().toISOString()
            };
        }));
    }
    async mutateSession(sessionId, mutate) {
        await this.withSessionLock(sessionId, async () => {
            const session = await this.readSession(sessionId);
            mutate(session);
            await this.writeSession(session);
        });
    }
    async writeSession(session) {
        const paths = this.getSessionPaths(session.id);
        await fs.mkdir(paths.dir, { recursive: true });
        const tmpPath = `${paths.filePath}.tmp`;
        await fs.writeFile(tmpPath, JSON.stringify(session, null, 2) + "\n", "utf8");
        await fs.rename(tmpPath, paths.filePath);
    }
    async withSessionLock(sessionId, operation) {
        const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
        const tracked = current.then(() => undefined, () => undefined);
        this.sessionLocks.set(sessionId, tracked);
        try {
            return await current;
        }
        finally {
            if (this.sessionLocks.get(sessionId) === tracked) {
                this.sessionLocks.delete(sessionId);
            }
        }
    }
}
function findTask(session, taskId) {
    const task = session.tasks.find((entry) => entry.id === taskId);
    if (!task) {
        throw new Error(`Task not found: ${taskId}`);
    }
    return task;
}
function sanitizeFilename(fileName) {
    return fileName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "upload.bin";
}
