import { describe, expect, it } from "vitest";

import type { CalendarEvent } from "../desktop/calendar/ical-events.ts";
import {
  dueReminders,
  nextMeeting,
  nextReminderAt,
  pickLanguage,
  reminderText,
  shouldRemind,
  trayLabel
} from "../desktop/calendar/reminders.ts";

const at = (iso: string): Date => new Date(iso);

const meeting = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  key: "m|2026-11-10T10:00:00.000Z",
  uid: "m",
  title: "Standup",
  start: at("2026-11-10T10:00:00Z"),
  end: at("2026-11-10T10:15:00Z"),
  allDay: false,
  location: "",
  attendees: [],
  myStatus: "accepted",
  createdAt: at("2026-11-01T00:00:00Z"),
  link: { provider: "meet", url: "https://meet.google.com/abc-defg-hij" },
  ...overrides
});

describe("shouldRemind", () => {
  const now = at("2026-11-10T09:00:00Z");

  it("skips all-day events and declined invites", () => {
    expect(shouldRemind(meeting({ allDay: true }), now)).toBe(false);
    expect(shouldRemind(meeting({ myStatus: "declined" }), now)).toBe(false);
  });

  it("skips invites left unanswered for 14 days, keeps fresher ones", () => {
    expect(shouldRemind(meeting({ myStatus: "needs-action", createdAt: at("2026-10-27T09:00:00Z") }), now)).toBe(false);
    expect(shouldRemind(meeting({ myStatus: "needs-action", createdAt: at("2026-10-28T09:00:00Z") }), now)).toBe(true);
    expect(shouldRemind(meeting({ myStatus: "needs-action", createdAt: null }), now)).toBe(true);
  });

  it("reminds tentative, organized and unknown-status meetings", () => {
    for (const myStatus of ["tentative", "organizer", "unknown"] as const) {
      expect(shouldRemind(meeting({ myStatus }), now)).toBe(true);
    }
  });
});

describe("dueReminders", () => {
  it("fires 15 min, 5 min and start reminders at their times", () => {
    const events = [meeting()];
    expect(dueReminders(events, at("2026-11-10T09:44:00Z"), at("2026-11-10T09:45:00Z")).map((r) => r.kind))
      .toEqual(["before-15"]);
    expect(dueReminders(events, at("2026-11-10T09:45:00Z"), at("2026-11-10T09:55:00Z")).map((r) => r.kind))
      .toEqual(["before-5"]);
    expect(dueReminders(events, at("2026-11-10T09:55:00Z"), at("2026-11-10T10:00:00Z")).map((r) => r.kind))
      .toEqual(["start"]);
    expect(dueReminders(events, at("2026-11-10T10:00:00Z"), at("2026-11-10T10:01:00Z"))).toEqual([]);
  });

  it("shows only the latest reminder when several are due at once", () => {
    const due = dueReminders([meeting()], at("2026-11-10T09:00:00Z"), at("2026-11-10T10:01:00Z"));
    expect(due.map((r) => r.kind)).toEqual(["start"]);
  });

  it("drops reminders older than the catch-up window", () => {
    expect(dueReminders([meeting()], at("2026-11-10T09:00:00Z"), at("2026-11-10T10:06:00Z"))).toEqual([]);
  });

  it("never reminds about a declined meeting", () => {
    expect(
      dueReminders([meeting({ myStatus: "declined" })], at("2026-11-10T09:00:00Z"), at("2026-11-10T10:00:00Z"))
    ).toEqual([]);
  });
});

describe("nextReminderAt / nextMeeting", () => {
  const later = meeting({ key: "l", title: "Retro", start: at("2026-11-10T14:00:00Z"), end: at("2026-11-10T15:00:00Z") });

  it("returns the earliest future reminder", () => {
    expect(nextReminderAt([later, meeting()], at("2026-11-10T09:50:00Z"))).toEqual(at("2026-11-10T09:55:00Z"));
    expect(nextReminderAt([meeting()], at("2026-11-10T10:00:00Z"))).toBeNull();
  });

  it("shows a meeting until it ends, then the next one", () => {
    expect(nextMeeting([later, meeting()], at("2026-11-10T10:05:00Z"))?.title).toBe("Standup");
    expect(nextMeeting([later, meeting()], at("2026-11-10T10:15:00Z"))?.title).toBe("Retro");
    expect(nextMeeting([meeting({ allDay: true })], at("2026-11-10T09:00:00Z"))).toBeNull();
  });
});

describe("texts", () => {
  const event = meeting({
    attendees: [
      { email: "a@x", name: "Olena", status: "accepted" },
      { email: "b@x", name: "Taras", status: "declined" },
      { email: "c@x", name: "Ivan", status: "accepted" },
      { email: "d@x", name: "Maria", status: "tentative" },
      { email: "e@x", name: "Petro", status: "needs-action" }
    ]
  });

  it("picks Ukrainian or English from the system languages", () => {
    expect(pickLanguage(["uk-UA", "en-US"])).toBe("uk");
    expect(pickLanguage(["de-DE", "en-GB"])).toBe("en");
    expect(pickLanguage(["de-DE"])).toBe("en");
  });

  it("writes the reminder in both languages", () => {
    const reminder = { kind: "before-15" as const, at: at("2026-11-10T09:45:00Z"), event };
    const uk = reminderText(reminder, "uk", at("2026-11-10T09:45:00Z"));
    const en = reminderText(reminder, "en", at("2026-11-10T09:45:00Z"));
    expect(uk.title).toBe("За 15 хв: Standup");
    expect(en.title).toBe("In 15 min: Standup");
    expect(en.body).toContain("Google Meet");
    expect(en.body).toContain("Olena, Ivan, Maria, +1");
    expect(en.body).not.toContain("Taras");
  });

  it("says the meeting is starting at start time and when the link is missing", () => {
    const reminder = { kind: "start" as const, at: event.start, event: meeting({ link: null }) };
    const uk = reminderText(reminder, "uk", event.start);
    expect(uk.title).toBe("Починається: Standup");
    expect(uk.body).toContain("без посилання");
  });

  it("labels the tray row as now or next", () => {
    expect(trayLabel(event, "en", at("2026-11-10T09:00:00Z"))).toMatch(/^Next: .+ Standup$/);
    expect(trayLabel(event, "uk", at("2026-11-10T10:05:00Z"))).toMatch(/^Зараз: .+ Standup$/);
  });
});
