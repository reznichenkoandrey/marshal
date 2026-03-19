import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ExecutionRoute } from "../agent/runtime/types.ts";
import type {
  OperatorAttachment,
  OperatorMessage,
  OperatorProjectSummary,
  OperatorSession,
  OperatorSessionSummary,
  OperatorTask,
  UploadPayload
} from "./types.ts";

const DEFAULT_PROJECT_NAME = (process.env.OPERATOR_DEFAULT_PROJECT_NAME ?? "Andrii").trim() || "Andrii";
const LEGACY_PROJECT_ID = "legacy-chats";
const LEGACY_PROJECT_NAME = "Imported chats";
const SESSION_FILE_NAME = "session.json";
const PROJECT_FILE_NAME = "project.json";

type ProjectRecord = {
  id: string;
  name: string;
  createdAt: string;
  dir: string;
  sessionsDir: string;
  isLegacy: boolean;
};

type SessionPaths = {
  dir: string;
  filePath: string;
  workspaceDir: string;
  memoryDir: string;
  uploadsDir: string;
};

export class OperatorSessionStore {
  rootDir: string;
  projectsDir: string;
  legacySessionsDir: string;
  private sessionLocks = new Map<string, Promise<unknown>>();

  constructor(rootDir = path.resolve(process.cwd(), "operator-data")) {
    this.rootDir = rootDir;
    this.projectsDir = path.join(rootDir, "projects");
    this.legacySessionsDir = path.join(rootDir, "sessions");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.mkdir(this.projectsDir, { recursive: true });
    await this.ensureProject({ name: DEFAULT_PROJECT_NAME });
  }

  async listProjects(): Promise<OperatorProjectSummary[]> {
    await this.initialize();
    const projects = await this.readProjectRecords();
    const summaries = await Promise.all(
      projects.map(async (project) => ({
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        sessionCount: await this.countProjectSessions(project),
        isDefault: project.name === DEFAULT_PROJECT_NAME,
        isLegacy: project.isLegacy
      }))
    );

    return summaries.sort((left, right) => {
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }

      if (left.isLegacy !== right.isLegacy) {
        return left.isLegacy ? 1 : -1;
      }

      if (right.sessionCount !== left.sessionCount) {
        return right.sessionCount - left.sessionCount;
      }

      return left.name.localeCompare(right.name);
    });
  }

  async createProject(name?: string): Promise<OperatorProjectSummary> {
    const project = await this.ensureProject({ name });
    return {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      sessionCount: await this.countProjectSessions(project),
      isDefault: project.name === DEFAULT_PROJECT_NAME,
      isLegacy: project.isLegacy
    };
  }

  async listSessions(projectId?: string): Promise<OperatorSessionSummary[]> {
    await this.initialize();
    const projects = projectId
      ? [await this.resolveProject(projectId)]
      : await this.readProjectRecords();
    const sessions = await Promise.all(projects.map(async (project) => this.listSessionsForProject(project)));

    return sessions
      .flat()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createSession(title?: string, projectId?: string): Promise<OperatorSession> {
    await this.initialize();
    const project = await this.resolveProject(projectId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const session: OperatorSession = {
      id,
      projectId: project.id,
      projectName: project.name,
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

    const paths = this.getPathsForProject(project, id);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.mkdir(paths.workspaceDir, { recursive: true });
    await fs.mkdir(paths.memoryDir, { recursive: true });
    await this.writeSession(session);
    return session;
  }

  async readSession(sessionId: string, projectId?: string): Promise<OperatorSession> {
    const located = await this.locateSession(sessionId, projectId);
    const raw = await fs.readFile(located.paths.filePath, "utf8");
    return normalizeSession(JSON.parse(raw) as Partial<OperatorSession>, located.project);
  }

  async deleteSession(sessionId: string, projectId?: string): Promise<void> {
    const session = await this.readSession(sessionId, projectId);
    const activeTask = session.tasks.find((task) => task.status === "queued" || task.status === "running");
    if (activeTask) {
      throw new Error("Cannot delete a chat while a task is queued or running.");
    }

    const paths = await this.getSessionPaths(sessionId, projectId);
    await fs.rm(paths.dir, { recursive: true, force: true });
  }

  async createTaskFromMessage(input: {
    sessionId: string;
    projectId?: string;
    text: string;
    route: ExecutionRoute;
    uploads: UploadPayload[];
  }): Promise<OperatorTask> {
    const trimmedText = input.text.trim();
    if (!trimmedText) {
      throw new Error("Task text is required.");
    }

    return this.withSessionLock(input.sessionId, async () => {
      const session = await this.readSession(input.sessionId, input.projectId);
      const attachments = await this.saveUploads(input.sessionId, session.projectId, input.uploads);
      const now = new Date().toISOString();
      const taskId = randomUUID();
      const task: OperatorTask = {
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
      const message: OperatorMessage = {
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

  async markTaskRunning(sessionId: string, taskId: string, projectId?: string): Promise<void> {
    await this.mutateSession(sessionId, projectId, (session) => {
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

  async appendTaskEvent(sessionId: string, taskId: string, type: string, detail: string, projectId?: string): Promise<void> {
    await this.mutateSession(sessionId, projectId, (session) => {
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

  async markTaskCompleted(sessionId: string, taskId: string, result: string, projectId?: string): Promise<void> {
    await this.mutateSession(sessionId, projectId, (session) => {
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

  async markTaskFailed(sessionId: string, taskId: string, error: string, projectId?: string): Promise<void> {
    await this.mutateSession(sessionId, projectId, (session) => {
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

  async getSessionPaths(sessionId: string, projectId?: string): Promise<SessionPaths> {
    const located = await this.locateSession(sessionId, projectId);
    return located.paths;
  }

  private async listSessionsForProject(project: ProjectRecord): Promise<OperatorSessionSummary[]> {
    await fs.mkdir(project.sessionsDir, { recursive: true });
    const dirents = await fs.readdir(project.sessionsDir, { withFileTypes: true });
    const sessions = await Promise.all(
      dirents
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => this.readSession(entry.name, project.id).catch(() => null))
    );

    return sessions
      .filter((session): session is OperatorSession => session !== null)
      .map((session) => {
        const activeTask = session.tasks.find((task) => task.id === session.activeTaskId) ?? null;
        return {
          id: session.id,
          projectId: session.projectId,
          projectName: session.projectName,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          activeTaskId: session.activeTaskId,
          activeTaskStatus: activeTask?.status ?? null,
          messageCount: session.messages.length
        };
      });
  }

  private async readProjectRecords(): Promise<ProjectRecord[]> {
    const projects: ProjectRecord[] = [];
    const dirents = await fs.readdir(this.projectsDir, { withFileTypes: true }).catch(() => []);

    for (const entry of dirents) {
      if (!entry.isDirectory()) {
        continue;
      }

      const dir = path.join(this.projectsDir, entry.name);
      const projectFilePath = path.join(dir, PROJECT_FILE_NAME);
      const raw = await fs.readFile(projectFilePath, "utf8").catch(() => null);
      if (!raw) {
        continue;
      }

      const parsed = JSON.parse(raw) as Partial<Pick<ProjectRecord, "id" | "name" | "createdAt">>;
      const id = typeof parsed.id === "string" && parsed.id.trim() ? parsed.id : entry.name;
      const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : entry.name;
      const createdAt =
        typeof parsed.createdAt === "string" && parsed.createdAt.trim()
          ? parsed.createdAt
          : new Date().toISOString();

      projects.push({
        id,
        name,
        createdAt,
        dir,
        sessionsDir: path.join(dir, "sessions"),
        isLegacy: false
      });
    }

    const legacyExists = await hasDirectory(this.legacySessionsDir);
    if (legacyExists) {
      const legacyCount = await countDirectories(this.legacySessionsDir);
      if (legacyCount > 0) {
        projects.push({
          id: LEGACY_PROJECT_ID,
          name: LEGACY_PROJECT_NAME,
          createdAt: new Date(0).toISOString(),
          dir: this.legacySessionsDir,
          sessionsDir: this.legacySessionsDir,
          isLegacy: true
        });
      }
    }

    return projects;
  }

  private async ensureProject(input: { id?: string; name?: string }): Promise<ProjectRecord> {
    await fs.mkdir(this.projectsDir, { recursive: true });
    const requestedId = input.id?.trim();
    const requestedName = input.name?.trim() || DEFAULT_PROJECT_NAME;
    const existing = await this.readProjectRecords();

    if (requestedId) {
      const matchedById = existing.find((project) => project.id === requestedId);
      if (matchedById) {
        return matchedById;
      }
    }

    const matchedByName = existing.find(
      (project) => !project.isLegacy && project.name.toLowerCase() === requestedName.toLowerCase()
    );
    if (matchedByName) {
      return matchedByName;
    }

    const existingIds = new Set(existing.map((project) => project.id));
    const baseId = slugifyProjectId(requestedId || requestedName);
    let projectId = baseId;
    let suffix = 2;
    while (existingIds.has(projectId)) {
      projectId = `${baseId}-${suffix}`;
      suffix += 1;
    }

    const createdAt = new Date().toISOString();
    const dir = path.join(this.projectsDir, projectId);
    const project: ProjectRecord = {
      id: projectId,
      name: requestedName,
      createdAt,
      dir,
      sessionsDir: path.join(dir, "sessions"),
      isLegacy: false
    };

    await fs.mkdir(project.sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(project.dir, PROJECT_FILE_NAME),
      JSON.stringify(
        {
          id: project.id,
          name: project.name,
          createdAt: project.createdAt
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    return project;
  }

  private async resolveProject(projectId?: string): Promise<ProjectRecord> {
    if (!projectId) {
      return this.ensureProject({ name: DEFAULT_PROJECT_NAME });
    }

    const projects = await this.readProjectRecords();
    const matched = projects.find((project) => project.id === projectId);
    if (matched) {
      return matched;
    }

    throw new Error(`Project not found: ${projectId}`);
  }

  private async locateSession(
    sessionId: string,
    projectId?: string
  ): Promise<{ project: ProjectRecord; paths: SessionPaths }> {
    const projects = projectId
      ? [await this.resolveProject(projectId)]
      : await this.readProjectRecords();

    for (const project of projects) {
      const paths = this.getPathsForProject(project, sessionId);
      if (await hasFile(paths.filePath)) {
        return { project, paths };
      }
    }

    throw new Error(`Session not found: ${sessionId}`);
  }

  private getPathsForProject(project: ProjectRecord, sessionId: string): SessionPaths {
    const dir = path.join(project.sessionsDir, sessionId);
    return {
      dir,
      filePath: path.join(dir, SESSION_FILE_NAME),
      workspaceDir: path.join(dir, "workspace"),
      memoryDir: path.join(dir, "memory"),
      uploadsDir: path.join(dir, "workspace", "uploads")
    };
  }

  private async saveUploads(
    sessionId: string,
    projectId: string,
    uploads: UploadPayload[]
  ): Promise<OperatorAttachment[]> {
    if (uploads.length === 0) {
      return [];
    }

    const paths = await this.getSessionPaths(sessionId, projectId);
    await fs.mkdir(paths.uploadsDir, { recursive: true });

    return Promise.all(
      uploads.map(async (upload) => {
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
      })
    );
  }

  private async mutateSession(
    sessionId: string,
    projectId: string | undefined,
    mutate: (session: OperatorSession) => void
  ): Promise<void> {
    await this.withSessionLock(sessionId, async () => {
      const session = await this.readSession(sessionId, projectId);
      mutate(session);
      await this.writeSession(session);
    });
  }

  private async writeSession(session: OperatorSession): Promise<void> {
    const project = await this.resolveProject(session.projectId);
    const paths = this.getPathsForProject(project, session.id);
    await fs.mkdir(paths.dir, { recursive: true });
    const tmpPath = `${paths.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(session, null, 2) + "\n", "utf8");
    await fs.rename(tmpPath, paths.filePath);
  }

  private async countProjectSessions(project: ProjectRecord): Promise<number> {
    return countDirectories(project.sessionsDir);
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tracked = current.then(
      () => undefined,
      () => undefined
    );
    this.sessionLocks.set(sessionId, tracked);

    try {
      return await current;
    } finally {
      if (this.sessionLocks.get(sessionId) === tracked) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }
}

function findTask(session: OperatorSession, taskId: string): OperatorTask {
  const task = session.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  return task;
}

function sanitizeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "upload.bin";
}

function slugifyProjectId(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "project";
}

function normalizeSession(raw: Partial<OperatorSession>, project: ProjectRecord): OperatorSession {
  return {
    id: String(raw.id ?? ""),
    projectId: typeof raw.projectId === "string" && raw.projectId.trim() ? raw.projectId : project.id,
    projectName: typeof raw.projectName === "string" && raw.projectName.trim() ? raw.projectName : project.name,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "Untitled session",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    activeTaskId: typeof raw.activeTaskId === "string" ? raw.activeTaskId : null,
    messages: Array.isArray(raw.messages) ? (raw.messages as OperatorMessage[]) : [],
    tasks: Array.isArray(raw.tasks) ? (raw.tasks as OperatorTask[]) : []
  };
}

async function hasDirectory(targetPath: string): Promise<boolean> {
  const stat = await fs.stat(targetPath).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function hasFile(targetPath: string): Promise<boolean> {
  const stat = await fs.stat(targetPath).catch(() => null);
  return Boolean(stat?.isFile());
}

async function countDirectories(targetPath: string): Promise<number> {
  const dirents = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
  return dirents.filter((entry) => entry.isDirectory()).length;
}
