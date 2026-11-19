// Action items from a call's notes.json (#294) and the text sent to a Claude
// Code session. Pure; the send goes through the same reply path as the
// owner's voice answers, so a session never gets text it is not idle for.

import { replyRefusal, replyToSession, type ReplyDeps } from "../claude-code/reply.ts";
import type { ClaudeSession } from "../claude-code/registry.ts";
import type { MeetingTask } from "./meeting-notes.ts";

export type TaskCall = { title: string; startedAt: string; language: "uk" | "en" };

const MAX_TASK_CHARS = 2_000;

/** Reads `tasks` from a notes.json body; malformed items are skipped, not fatal. */
export function tasksFromNotesJson(raw: string): MeetingTask[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as { tasks?: unknown }).tasks)) return [];
  const tasks: MeetingTask[] = [];
  for (const item of (data as { tasks: unknown[] }).tasks) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const task = typeof record.task === "string" ? record.task.trim() : "";
    if (task === "") continue;
    const owner = typeof record.owner === "string" && record.owner.trim() !== "" ? record.owner.trim() : null;
    tasks.push({ task, owner, mine: record.mine === true });
  }
  return tasks;
}

/** The message a session receives: the task, then where it came from. */
export function taskMessage(task: MeetingTask, call: TaskCall): string {
  const date = call.startedAt.slice(0, 10);
  const context = call.language === "uk"
    ? `Задача з дзвінка «${call.title}» (${date}).`
    : `Action item from the call "${call.title}" (${date}).`;
  const body = task.task.slice(0, MAX_TASK_CHARS);
  return `${body}\n\n${context}`;
}

/**
 * Sends one task to the named session through the reply path. Returns the
 * refusal or outcome text; nothing is typed unless the session is idle.
 */
export async function sendTaskToSession(
  session: ClaudeSession | undefined,
  name: string,
  message: string,
  deps: ReplyDeps
): Promise<string> {
  const refusal = replyRefusal(session, name);
  if (refusal) return refusal;
  return replyToSession(session as ClaudeSession, message, deps);
}
