// Persisted typed and session-finish reminders (#270). The pure decisions
// live in reminders.ts; this owns the file in userData and the timer that
// only runs while something is pending (#281: no polling when idle).

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dueTimedReminders, parseStoredReminders, type ReminderTrigger, type TimedReminder } from "./reminders.ts";

export const TIMED_REMINDER_TICK_MS = 30_000;

export class TimedReminderStore {
  private reminders: TimedReminder[];
  private timer: ReturnType<typeof setInterval> | null = null;
  // Sessions whose turn ended since the last fire; cleared once a fire has seen them.
  private finished = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly onDue: (reminder: TimedReminder) => void
  ) {
    this.reminders = this.load();
  }

  pending(): TimedReminder[] {
    return this.reminders.filter((reminder) => !reminder.done);
  }

  add(text: string, trigger: ReminderTrigger, now: number): TimedReminder {
    const reminder: TimedReminder = { id: randomUUID(), text, trigger, createdAt: now, done: false };
    this.reminders.push(reminder);
    this.save();
    this.arm();
    return reminder;
  }

  /** A session's turn ended (Stop hook); fires any reminder waiting on it. */
  sessionFinished(name: string): void {
    this.finished.add(name);
    this.fire(Date.now());
  }

  /** Fires what is due (time reached or a named session finished); fired reminders are marked done. */
  fire(now: number): void {
    const due = dueTimedReminders(this.reminders, now, this.finished);
    this.finished.clear();
    if (due.length === 0) return;
    for (const reminder of due) {
      reminder.done = true;
      this.onDue(reminder);
    }
    this.save();
    this.arm();
  }

  /** Runs the tick only while reminders are pending; nothing is scheduled otherwise. */
  arm(): void {
    const needed = this.pending().length > 0;
    if (needed && !this.timer) {
      this.timer = setInterval(() => this.fire(Date.now()), TIMED_REMINDER_TICK_MS);
      this.timer.unref?.();
    } else if (!needed && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private load(): TimedReminder[] {
    try {
      return parseStoredReminders(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.reminders.slice(-200), null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn("[reminders] save failed:", err instanceof Error ? err.message : err);
    }
  }
}
