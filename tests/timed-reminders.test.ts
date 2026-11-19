import { describe, expect, it } from "vitest";

import {
  dueTimedReminders,
  parseReminderPhrase,
  parseStoredReminders,
  sessionFinished,
  type TimedReminder
} from "../desktop/calendar/reminders.ts";

const NOW = Date.parse("2026-11-19T10:00:00Z");
const MIN = 60_000;

describe("parseReminderPhrase", () => {
  it("reads durations in English and Ukrainian", () => {
    expect(parseReminderPhrase("in 30 min", NOW)).toEqual({ kind: "at", at: NOW + 30 * MIN });
    expect(parseReminderPhrase("remind me in 2 hours", NOW)).toEqual({ kind: "at", at: NOW + 120 * MIN });
    expect(parseReminderPhrase("через 30 хв", NOW)).toEqual({ kind: "at", at: NOW + 30 * MIN });
    expect(parseReminderPhrase("за 1 год", NOW)).toEqual({ kind: "at", at: NOW + 60 * MIN });
  });

  it("reads session triggers", () => {
    expect(parseReminderPhrase("after marshal", NOW)).toEqual({ kind: "session", session: "marshal" });
    expect(parseReminderPhrase("коли сесія snoriq закінчиться", NOW)).toEqual({ kind: "session", session: "snoriq" });
  });

  it("refuses phrases it cannot read instead of guessing", () => {
    expect(parseReminderPhrase("in 0 min", NOW)).toBeNull();
    expect(parseReminderPhrase("tomorrow maybe", NOW)).toBeNull();
    expect(parseReminderPhrase("", NOW)).toBeNull();
  });
});

describe("sessionFinished", () => {
  it("fires only on busy to idle", () => {
    expect(sessionFinished("busy", "idle")).toBe(true);
    expect(sessionFinished("idle", "idle")).toBe(false);
    expect(sessionFinished("waiting", "idle")).toBe(false);
    expect(sessionFinished(null, "idle")).toBe(false);
  });
});

describe("dueTimedReminders", () => {
  const reminders: TimedReminder[] = [
    { id: "a", text: "stand up", trigger: { kind: "at", at: NOW + MIN }, createdAt: NOW, done: false },
    { id: "b", text: "review", trigger: { kind: "session", session: "marshal" }, createdAt: NOW, done: false },
    { id: "c", text: "old", trigger: { kind: "at", at: NOW - MIN }, createdAt: NOW, done: true }
  ];

  it("fires time reminders once due, session reminders when the session finishes", () => {
    expect(dueTimedReminders(reminders, NOW, new Set()).map((r) => r.id)).toEqual([]);
    expect(dueTimedReminders(reminders, NOW + MIN, new Set()).map((r) => r.id)).toEqual(["a"]);
    expect(dueTimedReminders(reminders, NOW, new Set(["marshal"])).map((r) => r.id)).toEqual(["b"]);
  });

  it("never fires done reminders", () => {
    expect(dueTimedReminders(reminders, NOW + 10 * MIN, new Set(["marshal"])).map((r) => r.id)).not.toContain("c");
  });
});

describe("parseStoredReminders", () => {
  it("round-trips valid entries and drops malformed ones", () => {
    const valid: TimedReminder = { id: "a", text: "x", trigger: { kind: "at", at: NOW }, createdAt: NOW, done: false };
    const parsed = parseStoredReminders([valid, { id: "b", text: "y", trigger: { kind: "at", at: "soon" } }, null, "junk"]);
    expect(parsed).toEqual([valid]);
    expect(parseStoredReminders({ not: "a list" })).toEqual([]);
  });
});
