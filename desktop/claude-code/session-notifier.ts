// Turns hook events into system notifications: "<session>: finished" with a
// one-line summary of the answer, "<session> needs your confirmation", and a
// single reminder for a session still waiting ten minutes later. A reminder
// timer exists only while a session waits, so nothing ticks when idle (#281).

import path from "node:path";

import { shortAnswer, WAITING_REMINDER_MS, type HookEvent } from "./hook-events.ts";
import type { ClaudeSession } from "./registry.ts";
import { translate, type UiLanguage } from "../i18n/catalog.ts";

/** What the owner hears (#318): a finished turn's summary, or that a session waits. */
export type SpokenSessionEvent =
  | { kind: "finished"; sessionId: string; name: string; summary: string | null }
  | { kind: "waiting"; sessionId: string; name: string; confirmation: boolean };

export type NotifierDeps = {
  notify: (title: string, body: string, onClick: () => void) => void;
  speak?: (event: SpokenSessionEvent) => void;
  summarize: (text: string) => Promise<string | null>;
  findSession: (sessionId: string) => ClaudeSession | undefined;
  focus: (pid: number) => void;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /** UI language of the notification text; English when not given. */
  language?: () => UiLanguage;
};

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
    const lang = this.deps.language?.() ?? "en";

    if (event.type === "stop") {
      const summary = shortAnswer(event.lastMessage) ?? (await this.deps.summarize(event.lastMessage));
      this.deps.notify(translate(lang, "claude.finished", { name }), summary ?? translate(lang, "claude.finishedFallback"), onClick);
      this.deps.speak?.({ kind: "finished", sessionId: event.sessionId, name, summary });
      return;
    }

    const title = translate(lang, event.reason === "confirmation" ? "claude.needsConfirmation" : "claude.needsInput", { name });
    this.deps.notify(title, event.message, onClick);
    this.deps.speak?.({ kind: "waiting", sessionId: event.sessionId, name, confirmation: event.reason === "confirmation" });
    this.reminders.set(event.sessionId, this.setTimer(() => {
      this.reminders.delete(event.sessionId);
      // Answered from the terminal, the session no longer waits — and only
      // the registry knows, because answering fires no hook.
      if (this.deps.findSession(event.sessionId)?.status !== "waiting") return;
      const later = this.deps.language?.() ?? "en";
      this.deps.notify(translate(later, "claude.stillWaiting", { name: this.nameOf(event.sessionId, event.cwd) }), event.message, onClick);
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
