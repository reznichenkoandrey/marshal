// What the assistant home shows in its centre (#284). Main owns the inputs
// (dictation, speech, sessions) and derives one state from them; the window
// only draws it. Pure, so the precedence is testable without Electron.

import path from "node:path";

import type { ClaudeSession, SessionStatus } from "../claude-code/registry.ts";

export const ASSISTANT_STATES = ["idle", "listening", "thinking", "speaking", "working", "waiting", "offline"] as const;
export type AssistantState = (typeof ASSISTANT_STATES)[number];

export type AssistantInputs = {
  dictating: boolean;
  transcribing: boolean;
  speaking: boolean;
  busySessions: number;
  waitingSessions: number;
  // No speech-to-text available: nothing the user says can be heard.
  offline: boolean;
};

export const IDLE_INPUTS: AssistantInputs = {
  dictating: false,
  transcribing: false,
  speaking: false,
  busySessions: 0,
  waitingSessions: 0,
  offline: false
};

/**
 * What the user is doing right now wins over what sessions are doing: while
 * they speak the visual must react to them, not to a busy session elsewhere.
 * A waiting session outranks a busy one because only it needs the user.
 */
export function deriveAssistantState(inputs: AssistantInputs): AssistantState {
  if (inputs.dictating) return "listening";
  if (inputs.transcribing) return "thinking";
  if (inputs.speaking) return "speaking";
  if (inputs.waitingSessions > 0) return "waiting";
  if (inputs.busySessions > 0) return "working";
  if (inputs.offline) return "offline";
  return "idle";
}

// ── Sessions panel (#308) ──────────────────────────────────────────────────

export type SessionView = {
  pid: number;
  name: string;
  status: SessionStatus | null;
  waitingFor: string | null;
};

export type SessionGroup = { project: string; sessions: SessionView[] };

const WORKTREE_MARKER = `${path.sep}.claude${path.sep}worktrees${path.sep}`;

/** A worktree session belongs to the repository it was cut from, not to its own folder. */
export function projectOf(cwd: string): string {
  const marker = cwd.indexOf(WORKTREE_MARKER);
  return path.basename(marker >= 0 ? cwd.slice(0, marker) : cwd);
}

const STATUS_RANK: Record<string, number> = { waiting: 0, busy: 1, shell: 2, idle: 3 };
const rank = (status: SessionStatus | null): number => STATUS_RANK[status ?? ""] ?? 4;

/** Projects with a waiting session first, then busy ones; inside, the same order. */
export function groupSessions(sessions: readonly ClaudeSession[]): SessionGroup[] {
  const groups = new Map<string, SessionView[]>();
  for (const session of sessions) {
    const project = projectOf(session.cwd);
    const list = groups.get(project) ?? [];
    list.push({ pid: session.pid, name: session.name, status: session.status, waitingFor: session.waitingFor });
    groups.set(project, list);
  }
  const ordered = [...groups].map(([project, list]) => ({
    project,
    sessions: list.sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name))
  }));
  return ordered.sort(
    (a, b) => rank(a.sessions[0].status) - rank(b.sessions[0].status) || a.project.localeCompare(b.project)
  );
}

export function sessionCounts(sessions: readonly Pick<ClaudeSession, "status">[]): Pick<AssistantInputs, "busySessions" | "waitingSessions"> {
  return {
    busySessions: sessions.filter((session) => session.status === "busy").length,
    waitingSessions: sessions.filter((session) => session.status === "waiting").length
  };
}

export const MAX_ASSISTANT_LINES = 5;

/** Newest first; a repeat of the newest line is not stacked twice. */
export function pushLine(lines: readonly string[], text: string, max = MAX_ASSISTANT_LINES): string[] {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line || lines[0] === line) return [...lines];
  return [line, ...lines].slice(0, max);
}
