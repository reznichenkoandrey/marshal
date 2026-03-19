import { runMarshalTask } from "../agent/runtime/marshal.js";
import { OperatorSessionStore } from "./session-store.js";
export class OperatorTaskService {
    store;
    sessionQueueTails = new Map();
    initializationPromise = null;
    constructor(store = new OperatorSessionStore()) {
        this.store = store;
    }
    async initialize() {
        if (!this.initializationPromise) {
            this.initializationPromise = this.initializeInternal();
        }
        await this.initializationPromise;
    }
    async listProjects() {
        await this.initialize();
        return this.store.listProjects();
    }
    async createProject(name) {
        await this.initialize();
        return this.store.createProject(name);
    }
    async listSessions(projectId) {
        await this.initialize();
        return this.store.listSessions(projectId);
    }
    async createSession(title, projectId) {
        await this.initialize();
        return this.store.createSession(title, projectId);
    }
    async readSession(sessionId, projectId) {
        await this.initialize();
        return this.store.readSession(sessionId, projectId);
    }
    async deleteSession(sessionId, projectId) {
        await this.initialize();
        await this.store.deleteSession(sessionId, projectId);
    }
    async getSessionPaths(sessionId, projectId) {
        await this.initialize();
        return this.store.getSessionPaths(sessionId, projectId);
    }
    async submitTask(input) {
        await this.initialize();
        const task = await this.store.createTaskFromMessage(input);
        this.enqueueTask(input.sessionId, task.id);
        return this.store.readSession(input.sessionId, input.projectId);
    }
    async getHealth(port) {
        const [projects, sessions] = await Promise.all([this.listProjects(), this.listSessions()]);
        return {
            port,
            projectCount: projects.length,
            sessionCount: sessions.length,
            queuedTasks: sessions.filter((session) => session.activeTaskStatus === "queued").length,
            runningTasks: sessions.filter((session) => session.activeTaskStatus === "running").length
        };
    }
    async initializeInternal() {
        await this.store.initialize();
        await this.resumePendingTasks();
    }
    enqueueTask(sessionId, taskId) {
        const previous = this.sessionQueueTails.get(sessionId) ?? Promise.resolve();
        const current = previous
            .then(() => this.runQueuedTask(sessionId, taskId))
            .catch(async (error) => {
            const message = error instanceof Error ? error.message : "Unknown queue error.";
            await this.store.markTaskFailed(sessionId, taskId, message).catch(() => undefined);
        });
        this.sessionQueueTails.set(sessionId, current);
        void current.finally(() => {
            if (this.sessionQueueTails.get(sessionId) === current) {
                this.sessionQueueTails.delete(sessionId);
            }
        });
    }
    async runQueuedTask(sessionId, taskId) {
        const session = await this.store.readSession(sessionId);
        const task = session.tasks.find((entry) => entry.id === taskId);
        if (!task) {
            return;
        }
        const paths = await this.store.getSessionPaths(sessionId, session.projectId);
        await this.store.markTaskRunning(sessionId, taskId, session.projectId);
        try {
            const result = await runMarshalTask({
                task: task.prompt,
                route: task.route,
                attachments: task.attachments,
                workspaceRoot: paths.workspaceDir,
                memoryDir: paths.memoryDir,
                // Operator projects currently scope Marshal sessions and storage, not ChatGPT sidebar projects.
                onEvent: async (event) => {
                    await this.store.appendTaskEvent(sessionId, taskId, event.type, formatRuntimeEvent(event), event, session.projectId);
                }
            });
            await this.store.markTaskCompleted(sessionId, taskId, result, session.projectId);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown task failure.";
            await this.store.markTaskFailed(sessionId, taskId, message, session.projectId);
        }
    }
    async resumePendingTasks() {
        const sessions = await this.store.listSessions();
        for (const sessionSummary of sessions) {
            const session = await this.store.readSession(sessionSummary.id).catch(() => null);
            if (!session) {
                continue;
            }
            for (const task of session.tasks) {
                if (task.status === "queued") {
                    this.enqueueTask(session.id, task.id);
                    continue;
                }
                if (task.status === "running") {
                    await this.store
                        .markTaskFailed(session.id, task.id, "Operator server restarted before task completion.", session.projectId)
                        .catch(() => undefined);
                }
            }
        }
    }
}
export function normalizeRoute(value) {
    return value === "local" || value === "browser" ? value : "auto";
}
export function sanitizeUploads(value) {
    return value
        .filter((item) => typeof item === "object" && item !== null)
        .map((item) => ({
        name: String(item.name ?? "upload.bin"),
        mimeType: String(item.mimeType ?? "application/octet-stream"),
        contentBase64: String(item.contentBase64 ?? "")
    }))
        .filter((item) => item.contentBase64.length > 0);
}
export function formatRuntimeEvent(event) {
    switch (event.type) {
        case "queued":
            return `Task queued with route ${event.route}.`;
        case "running":
            return "Task execution started.";
        case "completed":
            return "Task completed successfully.";
        case "failed":
            return event.error;
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
