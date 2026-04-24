import { createReasoningBridge } from "../agent/bridge/factory.ts";
import type { ReasoningBridge } from "../agent/bridge/types.ts";
import { runMarshalTask } from "../agent/runtime/marshal.ts";
import type {
  ExecutionRoute,
  MarshalRuntimeEvent,
  RuntimePriorMessage
} from "../agent/runtime/types.ts";
import { OperatorSessionStore } from "./session-store.ts";
import type {
  OperatorMessage,
  OperatorProjectSummary,
  OperatorSession,
  OperatorSessionSummary,
  OperatorTaskEventPayload,
  UploadPayload
} from "./types.ts";

type SubmitTaskInput = {
  sessionId: string;
  projectId?: string;
  text: string;
  route: ExecutionRoute;
  uploads: UploadPayload[];
  workingDir?: string;
};

type OperatorHealth = {
  port?: number;
  projectCount: number;
  sessionCount: number;
  queuedTasks: number;
  runningTasks: number;
};

type OperatorSessionPaths = {
  dir: string;
  filePath: string;
  workspaceDir: string;
  memoryDir: string;
  uploadsDir: string;
};

export class OperatorTaskService {
  readonly store: OperatorSessionStore;
  private sessionQueueTails = new Map<string, Promise<void>>();
  private taskWorkingDirs = new Map<string, string>();
  private initializationPromise: Promise<void> | null = null;
  private sharedBridge: ReasoningBridge | null = null;

  constructor(store = new OperatorSessionStore()) {
    this.store = store;
  }

  /** Get or create a shared bridge instance (singleton per service lifetime) */
  private getSharedBridge(): ReasoningBridge {
    if (!this.sharedBridge) {
      this.sharedBridge = createReasoningBridge();
    }
    return this.sharedBridge;
  }

  async initialize(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeInternal();
    }

    await this.initializationPromise;
  }

  async listProjects(): Promise<OperatorProjectSummary[]> {
    await this.initialize();
    return this.store.listProjects();
  }

  async createProject(name?: string): Promise<OperatorProjectSummary> {
    await this.initialize();
    return this.store.createProject(name);
  }

  async listSessions(projectId?: string): Promise<OperatorSessionSummary[]> {
    await this.initialize();
    return this.store.listSessions(projectId);
  }

  async createSession(title?: string, projectId?: string): Promise<OperatorSession> {
    await this.initialize();
    return this.store.createSession(title, projectId);
  }

  async readSession(sessionId: string, projectId?: string): Promise<OperatorSession> {
    await this.initialize();
    return this.store.readSession(sessionId, projectId);
  }

  async deleteSession(sessionId: string, projectId?: string): Promise<void> {
    await this.initialize();
    await this.store.deleteSession(sessionId, projectId);
  }

  async getSessionPaths(sessionId: string, projectId?: string): Promise<OperatorSessionPaths> {
    await this.initialize();
    return this.store.getSessionPaths(sessionId, projectId);
  }

  async submitTask(input: SubmitTaskInput): Promise<OperatorSession> {
    await this.initialize();
    const task = await this.store.createTaskFromMessage(input);
    if (input.workingDir) {
      this.taskWorkingDirs.set(task.id, input.workingDir);
    }
    this.enqueueTask(input.sessionId, task.id);
    return this.store.readSession(input.sessionId, input.projectId);
  }

  async getHealth(port?: number): Promise<OperatorHealth> {
    const [projects, sessions] = await Promise.all([this.listProjects(), this.listSessions()]);
    return {
      port,
      projectCount: projects.length,
      sessionCount: sessions.length,
      queuedTasks: sessions.filter((session) => session.activeTaskStatus === "queued").length,
      runningTasks: sessions.filter((session) => session.activeTaskStatus === "running").length
    };
  }

  private async initializeInternal(): Promise<void> {
    await this.store.initialize();
    await this.resumePendingTasks();
  }

  private enqueueTask(sessionId: string, taskId: string): void {
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

  private async runQueuedTask(sessionId: string, taskId: string): Promise<void> {
    const session = await this.store.readSession(sessionId);
    const task = session.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      return;
    }

    const paths = await this.store.getSessionPaths(sessionId, session.projectId);
    await this.store.markTaskRunning(sessionId, taskId, session.projectId);

    try {
      // Use UI-selected working directory, fallback to home
      const workDir = this.taskWorkingDirs.get(taskId) ?? process.env.HOME ?? paths.workspaceDir;
      this.taskWorkingDirs.delete(taskId);
      const result = await runMarshalTask({
        task: task.prompt,
        route: task.route,
        attachments: task.attachments,
        priorMessages: collectPriorMessages(session.messages, taskId),
        workspaceRoot: workDir,
        memoryDir: paths.memoryDir,
        bridge: this.getSharedBridge(),
        onEvent: async (event) => {
          await this.store.appendTaskEvent(
            sessionId,
            taskId,
            event.type,
            formatRuntimeEvent(event),
            event,
            session.projectId
          );
        }
      });
      await this.store.markTaskCompleted(sessionId, taskId, result, session.projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown task failure.";
      await this.store.markTaskFailed(sessionId, taskId, message, session.projectId);
    }
  }

  private async resumePendingTasks(): Promise<void> {
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

export function normalizeRoute(value: unknown): ExecutionRoute {
  return value === "local" || value === "browser" ? value : "auto";
}

/**
 * Build the `priorMessages` list for {@link runMarshalTask} out of a session's
 * stored messages. Drops:
 *   - system messages (they carry no signal worth paying tokens for);
 *   - the current task's own user message (it's re-sent as the fresh prompt).
 *
 * Exported for unit-testing the filter logic without booting a real session.
 */
export function collectPriorMessages(
  messages: OperatorMessage[],
  currentTaskId: string
): RuntimePriorMessage[] {
  return messages
    .filter((m) => m.role !== "system" && m.taskId !== currentTaskId)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      text: m.text,
      attachments: m.attachments
    }));
}

export function sanitizeUploads(value: unknown[]): UploadPayload[] {
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      name: String(item.name ?? "upload.bin"),
      mimeType: String(item.mimeType ?? "application/octet-stream"),
      contentBase64: String(item.contentBase64 ?? "")
    }))
    .filter((item) => item.contentBase64.length > 0);
}

export function formatRuntimeEvent(event: MarshalRuntimeEvent | OperatorTaskEventPayload): string {
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
