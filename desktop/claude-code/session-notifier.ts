// Turns hook events into system notifications: "<session>: finished" with a
// one-line summary of the answer, "<session> needs your confirmation", and a
// single reminder for a session still waiting ten minutes later. A reminder
// timer exists only while a session waits, so nothing ticks when idle (#281).

import path from "node:path";

import { shortAnswer, spokenTail, WAITING_REMINDER_MS, type HookEvent } from "./hook-events.ts";
import type { ClaudeSession } from "./registry.ts";
import { translate, type UiLanguage } from "../i18n/catalog.ts";
import { shouldHoldNotification } from "../presence/call-policy.ts";

/** What the owner hears (#318): a finished turn's summary, or that a session waits. */
export type SpokenSessionEvent =
  | { kind: "finished"; sessionId: string; name: string; summary: string | null }
  | { kind: "waiting"; sessionId: string; name: string; cwd: string; message: string; confirmation: boolean };

export type NotifierDeps = {
  notify: (title: string, body: string, onClick: () => void) => void;
  speak?: (event: SpokenSessionEvent) => void;
  summarize: (text: string) => Promise<string | null>;
  /** The turn answers the owner's voice command (#508): its plain closing paragraph is spoken without a summary. */
  voiceAnswer?: (sessionId: string, name: string) => boolean;
  findSession: (sessionId: string) => ClaudeSession | undefined;
  focus: (pid: number) => void;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /** UI language of the notification text; English when not given. */
  language?: () => UiLanguage;
  /** True while a call is active (#267); finished results are held until it ends. */
  onCall?: () => Promise<boolean>;
};

// Held results are checked only while something is held: no timer at idle (#281).
const HOLD_CHECK_MS = 30_000;

export class SessionNotifier {
  private readonly reminders = new Map<string, NodeJS.Timeout>();
  private readonly held: Array<{ title: string; body: string }> = [];
  private holdTimer: NodeJS.Timeout | null = null;
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
      const direct = this.deps.voiceAnswer?.(event.sessionId, name) ? spokenTail(event.lastMessage) : null;
      const summary = direct ?? shortAnswer(event.lastMessage) ?? (await this.deps.summarize(event.lastMessage));
      const title = translate(lang, "claude.finished", { name });
      const body = summary ?? translate(lang, "claude.finishedFallback");
      if (shouldHoldNotification(false, (await this.deps.onCall?.()) ?? false)) this.hold(title, body);
      else this.deps.notify(title, body, onClick);
      this.deps.speak?.({ kind: "finished", sessionId: event.sessionId, name, summary });
      return;
    }

    const title = translate(lang, event.reason === "confirmation" ? "claude.needsConfirmation" : "claude.needsInput", { name });
    this.deps.notify(title, event.message, onClick);
    this.deps.speak?.({ kind: "waiting", sessionId: event.sessionId, name, cwd: event.cwd, message: event.message, confirmation: event.reason === "confirmation" });
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
    if (this.holdTimer) this.clearTimer(this.holdTimer);
    this.holdTimer = null;
    this.held.length = 0;
  }

  private hold(title: string, body: string): void {
    this.held.push({ title, body });
    if (!this.holdTimer) this.holdTimer = this.setTimer(() => void this.releaseHeld(), HOLD_CHECK_MS);
  }

  private async releaseHeld(): Promise<void> {
    this.holdTimer = null;
    if (this.held.length === 0) return;
    if (await this.deps.onCall?.()) {
      this.holdTimer = this.setTimer(() => void this.releaseHeld(), HOLD_CHECK_MS);
      return;
    }
    const lang = this.deps.language?.() ?? "en";
    const [first] = this.held;
    const notice = this.held.length === 1 && first
      ? first
      : { title: translate(lang, "call.digestTitle", { count: this.held.length }), body: this.held.map((item) => item.title).join("\n") };
    this.held.length = 0;
    this.deps.notify(notice.title, notice.body, () => {});
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
