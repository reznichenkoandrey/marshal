// A 2–3 line "dossier" per live Claude Code session — project, feature, what
// it is doing now — so a spoken command that names no session can be routed by
// what each session works on (#286). Built by a small model from the tail of
// the session's transcript, rebuilt at most every 10 minutes and only when the
// transcript moved: on a Stop hook event, or when a route needs it. No timer,
// so nothing runs while sessions are idle (#281).
//
// Transcript format (Claude Code 2.1.317, read from real files, undocumented):
// ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl, one JSON object per
// line. Conversation lines have `type: "user" | "assistant"`, `isSidechain`
// (subagent traffic) and `message.content` — a string, or blocks of `text`,
// `thinking`, `tool_use`, `tool_result`. Every line also carries `gitBranch`.
// The rest (`attachment`, `api-request*`, `file-history-*`, …) is bookkeeping.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OneShotRequest } from "./answer-summary.ts";
import type { ClaudeSession } from "./registry.ts";

export const DOSSIER_REFRESH_MS = 10 * 60_000;
// A dossier of a session that ended is useless; this drops it from the file.
const DOSSIER_KEEP_MS = 24 * 60 * 60_000;
// The last turns are what "doing now" means; 1 MB holds dozens of them even
// with the large api-request lines in between, and is read only on demand.
const TAIL_BYTES = 1024 * 1024;
const MAX_TURNS = 12;
const MAX_TURN_CHARS = 600;

export type Dossier = { text: string; builtAt: number; sourceMtimeMs: number };

export type TranscriptTail = { branch: string | null; turns: { role: "user" | "assistant"; text: string }[] };

/**
 * Rebuild only when the transcript changed since the last build and the last
 * build is at least DOSSIER_REFRESH_MS old. No transcript, nothing to build.
 */
export function shouldRefreshDossier(entry: Dossier | undefined, transcriptMtimeMs: number | null, now: number): boolean {
  if (transcriptMtimeMs === null) return false;
  if (!entry) return true;
  if (transcriptMtimeMs <= entry.sourceMtimeMs) return false;
  return now - entry.builtAt >= DOSSIER_REFRESH_MS;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : ""
    )
    .join("\n");
}

function clean(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * The recent conversation from the tail of a transcript. `partialFirstLine`
 * is true when the tail starts mid-file: its first line is cut and dropped.
 * Tool calls and results, thinking and subagent turns are skipped — they say
 * how, not what.
 */
export function parseTranscriptTail(tail: string, partialFirstLine: boolean): TranscriptTail {
  const lines = tail.split("\n");
  if (partialFirstLine) lines.shift();
  let branch: string | null = null;
  const turns: TranscriptTail["turns"] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let o: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      o = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof o.gitBranch === "string" && o.gitBranch !== "") branch = o.gitBranch;
    const role = o.type === "user" || o.type === "assistant" ? o.type : null;
    if (!role || o.isSidechain === true || o.isMeta === true) continue;
    const message = o.message as { content?: unknown } | undefined;
    const text = clean(contentText(message?.content));
    if (text === "") continue;
    turns.push({ role, text: text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)}…` : text });
  }
  return { branch, turns: turns.slice(-MAX_TURNS) };
}

const DOSSIER_SYSTEM =
  "You keep a dossier of what one Claude Code coding session is working on, so that a short voice command " +
  "can later be sent to the right session. Write exactly three short lines in English:\n" +
  "Project: <repository or product>\n" +
  "Feature: <the task, with issue/ticket numbers, branch and key technical terms verbatim>\n" +
  "Now: <what the session is doing at the moment>\n" +
  "No preamble, no markdown.";

export function buildDossierRequest(session: Pick<ClaudeSession, "name" | "cwd">, tail: TranscriptTail): OneShotRequest {
  const turns = tail.turns.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`).join("\n");
  return {
    system: DOSSIER_SYSTEM,
    user:
      `Session title: ${session.name}\nWorking directory: ${session.cwd}\nGit branch: ${tail.branch ?? "unknown"}\n\n` +
      `Recent turns, oldest first:\n${turns || "(none yet)"}`,
    maxTokens: 160,
    label: "session dossier"
  };
}

/** Three lines at most, thinking already stripped by the caller. */
export function parseDossierReply(reply: string | null): string | null {
  if (reply === null) return null;
  const lines = reply.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.length === 0 ? null : lines.slice(0, 3).join("\n");
}

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Where Claude Code keeps a session's transcript. The directory name encodes
 * the cwd, but not consistently across versions (`_` kept in older folders,
 * replaced in newer ones; long paths get truncated), so the encoded guess is
 * tried first and a scan for `<sessionId>.jsonl` is the fallback.
 */
export function locateTranscript(projectsDir: string, cwd: string, sessionId: string): string | null {
  const fileName = `${sessionId}.jsonl`;
  const guess = path.join(projectsDir, cwd.replace(/[^A-Za-z0-9]/gu, "-"), fileName);
  if (fs.existsSync(guess)) return guess;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projectsDir, dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readTail(filePath: string): { text: string; partial: boolean } {
  const fd = fs.openSync(filePath, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.toString("utf8"), partial: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

export type DossierKeeperDeps = {
  storePath: string;
  complete: (request: OneShotRequest) => Promise<string | null>;
  projectsDir?: string;
  now?: () => number;
};

/** Dossiers on disk in userData, rebuilt by the policy above. */
export class DossierKeeper {
  private readonly building = new Map<string, Promise<void>>();
  private cache: Record<string, Dossier> | null = null;

  constructor(private readonly deps: DossierKeeperDeps) {}

  /** Current dossiers for these sessions, rebuilding stale ones in parallel first. */
  async dossiersFor(sessions: readonly ClaudeSession[]): Promise<Map<string, string>> {
    await Promise.all(sessions.map((session) => this.refresh(session)));
    const all = this.load();
    const result = new Map<string, string>();
    for (const session of sessions) {
      const entry = all[session.sessionId];
      if (entry) result.set(session.sessionId, entry.text);
    }
    return result;
  }

  /** Rebuild one session's dossier if the policy says so; concurrent calls share one build. */
  refresh(session: Pick<ClaudeSession, "sessionId" | "name" | "cwd">): Promise<void> {
    const pending = this.building.get(session.sessionId);
    if (pending) return pending;
    const build = this.build(session).finally(() => this.building.delete(session.sessionId));
    this.building.set(session.sessionId, build);
    return build;
  }

  private async build(session: Pick<ClaudeSession, "sessionId" | "name" | "cwd">): Promise<void> {
    const now = this.now();
    const transcript = locateTranscript(this.deps.projectsDir ?? defaultProjectsDir(), session.cwd, session.sessionId);
    let mtimeMs: number | null = null;
    try {
      if (transcript) mtimeMs = fs.statSync(transcript).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    if (!transcript || !shouldRefreshDossier(this.load()[session.sessionId], mtimeMs, now)) return;

    let tail: TranscriptTail;
    try {
      const { text, partial } = readTail(transcript);
      tail = parseTranscriptTail(text, partial);
    } catch (err) {
      console.warn("[claude-code] transcript unreadable:", err instanceof Error ? err.message : err);
      return;
    }
    const dossier = parseDossierReply(await this.deps.complete(buildDossierRequest(session, tail)));
    if (dossier === null) return;
    const all = this.load();
    all[session.sessionId] = { text: dossier, builtAt: now, sourceMtimeMs: mtimeMs ?? now };
    this.save(all);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private load(): Record<string, Dossier> {
    if (this.cache) return this.cache;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.deps.storePath, "utf8"));
      this.cache = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, Dossier>) : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private save(all: Record<string, Dossier>): void {
    const now = this.now();
    for (const [id, entry] of Object.entries(all)) {
      if (typeof entry?.builtAt !== "number" || now - entry.builtAt > DOSSIER_KEEP_MS) delete all[id];
    }
    this.cache = all;
    try {
      fs.mkdirSync(path.dirname(this.deps.storePath), { recursive: true });
      const tmp = `${this.deps.storePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.deps.storePath);
    } catch (err) {
      console.warn("[claude-code] dossier store not written:", err instanceof Error ? err.message : err);
    }
  }
}
