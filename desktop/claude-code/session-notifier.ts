// Turns hook events into system notifications: "<session>: finished" with a
// one-line summary of the answer, "<session> needs your confirmation", and a
// single reminder for a session still waiting ten minutes later. A reminder
// timer exists only while a session waits, so nothing ticks when idle (#281).

import path from "node:path";

import { shortAnswer, WAITING_REMINDER_MS, type HookEvent } from "./hook-events.ts";
import type { ClaudeSession } from "./registry.ts";

/** What the owner hears (#318): a finished turn's summary, or that a session waits. */
export type SpokenSessionEvent =
  | { kind: "finished"; name: string; summary: string | null }
  | { kind: "waiting"; name: string; confirmation: boolean };

export type NotifierDeps = {
  notify: (title: string, body: string, onClick: () => void) => void;
  speak?: (event: SpokenSessionEvent) => void;
  summarize: (text: string) => Promise<string | null>;
  findSession: (sessionId: string) => ClaudeSession | undefined;
  focus: (pid: number) => void;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

const FINISHED_FALLBACK = "Finished, check the session.";

export class SessionNotifier {
  private readonly reminders = new Map<string, NodeJS.Timeout>();
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;

  constructor(private readonly deps: NotifierDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.clearTimer = deps.clearTimer ?? clearTimeout;
  }

  async handle(event: HookEvent): Promise<void> {
    this.cancelReminder(event.sessionId);
    const name = this.nameOf(event.sessionId, event.cwd);
    const onClick = () => this.focus(event.sessionId);

    if (event.type === "stop") {
      const summary = shortAnswer(event.lastMessage) ?? (await this.deps.summarize(event.lastMessage));
      this.deps.notify(`${name}: finished`, summary ?? FINISHED_FALLBACK, onClick);
      this.deps.speak?.({ kind: "finished", name, summary });
      return;
    }

    const title = event.reason === "confirmation" ? `${name} needs your confirmation` : `${name} needs your input`;
    this.deps.notify(title, event.message, onClick);
    this.deps.speak?.({ kind: "waiting", name, confirmation: event.reason === "confirmation" });
    this.reminders.set(event.sessionId, this.setTimer(() => {
      this.reminders.delete(event.sessionId);
      // Answered from the terminal, the session no longer waits — and only
      // the registry knows, because answering fires no hook.
      if (this.deps.findSession(event.sessionId)?.status !== "waiting") return;
      this.deps.notify(`${this.nameOf(event.sessionId, event.cwd)} is still waiting`, event.message, onClick);
    }, WAITING_REMINDER_MS));
  }

  dispose(): void {
    for (const timer of this.reminders.values()) this.clearTimer(timer);
    this.reminders.clear();
  }

  private cancelReminder(sessionId: string): void {
    const timer = this.reminders.get(sessionId);
    if (timer) this.clearTimer(timer);
    this.reminders.delete(sessionId);
  }

  private nameOf(sessionId: string, cwd: string): string {
    return this.deps.findSession(sessionId)?.name ?? (cwd ? path.basename(cwd) : "Claude Code");
  }

  private focus(sessionId: string): void {
    const session = this.deps.findSession(sessionId);
    if (session) this.deps.focus(session.pid);
  }
}
