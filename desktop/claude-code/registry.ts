// Live Claude Code sessions, read from the files Claude Code itself writes to
// ~/.claude/sessions/<pid>.json. The format is undocumented: everything here
// was learned from real files and from how Claude Code 2.1.x parses them, so a
// file that no longer matches is skipped with a log line, never a crash.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { translate, type UiLanguage } from "../i18n/catalog.ts";

export type SessionStatus = "busy" | "shell" | "idle" | "waiting";

export type ClaudeSession = {
  pid: number;
  sessionId: string;
  name: string;
  cwd: string;
  status: SessionStatus | null;
  // What a `waiting` session is blocked on: "permission prompt", "input needed", …
  waitingFor: string | null;
  // "claude-desktop", "claude-vscode", "cli", … — decides how to focus it.
  entrypoint: string | null;
  // Claude desktop's own id for the session ("local_<uuid>"); only desktop sessions have it.
  hostSessionId?: string;
  socketPath: string;
  startedAt: number;
  statusUpdatedAt: number | null;
};

const STATUSES: readonly SessionStatus[] = ["busy", "shell", "idle", "waiting"];
// Claude Code names a session file after its pid; anything else is a temp or
// foreign file it would ignore too.
const FILE_PATTERN = /^(\d+)\.json$/;
// The shape Claude desktop's claude://code/continue handler accepts.
const HOST_SESSION_ID = /^local_[A-Za-z0-9-]{1,64}$/;

export function defaultSessionsDir(): string {
  return path.join(os.homedir(), ".claude", "sessions");
}

/**
 * Parse one session file. Returns null for anything that is not a live-capable
 * interactive session: background jobs, daemons and print/SDK runs share the
 * directory but have no terminal to talk to.
 */
export function parseSessionFile(fileName: string, raw: string): ClaudeSession | null {
  const match = FILE_PATTERN.exec(fileName);
  if (!match) return null;
  const pid = Number(match[1]);

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const o = data as Record<string, unknown>;

  if (o.kind !== "interactive") return null;
  if (typeof o.pid === "number" && o.pid !== pid) return null;
  if (typeof o.sessionId !== "string" || typeof o.cwd !== "string") return null;
  if (typeof o.messagingSocketPath !== "string" || o.messagingSocketPath === "") return null;

  const status = STATUSES.includes(o.status as SessionStatus) ? (o.status as SessionStatus) : null;
  return {
    pid,
    sessionId: o.sessionId,
    name: typeof o.name === "string" && o.name.trim() !== "" ? o.name.trim() : path.basename(o.cwd),
    cwd: o.cwd,
    status,
    waitingFor: status === "waiting" && typeof o.waitingFor === "string" ? o.waitingFor : null,
    entrypoint: typeof o.entrypoint === "string" ? o.entrypoint : null,
    ...(typeof o.hostSessionId === "string" && HOST_SESSION_ID.test(o.hostSessionId)
      ? { hostSessionId: o.hostSessionId }
      : {}),
    socketPath: o.messagingSocketPath,
    startedAt: typeof o.startedAt === "number" ? o.startedAt : 0,
    statusUpdatedAt: typeof o.statusUpdatedAt === "number" ? o.statusUpdatedAt : null
  };
}

export type RegistryDeps = {
  dir: string;
  readDir: (dir: string) => string[];
  readFile: (filePath: string) => string;
  isAlive: (pid: number) => boolean;
  exists: (filePath: string) => boolean;
  warn: (message: string) => void;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const defaultDeps: RegistryDeps = {
  dir: defaultSessionsDir(),
  readDir: (dir) => fs.readdirSync(dir),
  readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
  isAlive,
  exists: (filePath) => fs.existsSync(filePath),
  warn: (message) => console.warn(`[claude-sessions] ${message}`)
};

/**
 * Read on demand — no watcher, nothing runs while nobody asks (#281). A file
 * left behind by a crashed session is dropped by the pid and socket checks.
 * Newest activity first.
 */
export function listLiveSessions(overrides: Partial<RegistryDeps> = {}): ClaudeSession[] {
  const deps = { ...defaultDeps, ...overrides };
  let names: string[];
  try {
    names = deps.readDir(deps.dir);
  } catch {
    return [];
  }

  const sessions: ClaudeSession[] = [];
  let unreadable = 0;
  for (const fileName of names) {
    if (!FILE_PATTERN.test(fileName)) continue;
    let raw: string;
    try {
      raw = deps.readFile(path.join(deps.dir, fileName));
    } catch {
      continue;
    }
    const session = parseSessionFile(fileName, raw);
    if (!session) {
      if (!isForeignKind(raw)) unreadable += 1;
      continue;
    }
    if (!deps.isAlive(session.pid) || !deps.exists(session.socketPath)) continue;
    sessions.push(session);
  }
  if (unreadable > 0) {
    deps.warn(`${unreadable} session file(s) in ${deps.dir} did not match the expected format`);
  }
  return sessions.sort(
    (a, b) => (b.statusUpdatedAt ?? b.startedAt) - (a.statusUpdatedAt ?? a.startedAt)
  );
}

// A bg/daemon file is a known shape we skip on purpose, not a format change.
function isForeignKind(raw: string): boolean {
  try {
    const kind = (JSON.parse(raw) as { kind?: unknown }).kind;
    return typeof kind === "string" && kind !== "interactive";
  } catch {
    return false;
  }
}

export function describeStatus(session: Pick<ClaudeSession, "status" | "waitingFor">, lang: UiLanguage = "en"): string {
  switch (session.status) {
    case "busy":
    case "shell":
    case "idle":
      return translate(lang, `session.status.${session.status}`);
    case "waiting":
      return session.waitingFor
        ? translate(lang, "session.status.waitingFor", { what: session.waitingFor })
        : translate(lang, "session.status.waiting");
    default:
      return translate(lang, "session.status.live");
  }
}
