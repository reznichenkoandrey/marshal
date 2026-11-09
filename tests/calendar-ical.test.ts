import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseCalendar, type CalendarEvent } from "../desktop/calendar/ical-events.ts";

const fixture = (name: string): string =>
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "calendar", name), "utf8");

const parse = (name: string, from: string, to: string): CalendarEvent[] =>
  parseCalendar(fixture(name), { from: new Date(from), to: new Date(to) });

const starts = (events: CalendarEvent[], title: string): string[] =>
  events.filter((event) => event.title.startsWith(title)).map((event) => event.start.toISOString());

describe("parseCalendar — recurring", () => {
  const events = parse("recurring.ics", "2026-11-09T00:00:00Z", "2026-11-19T00:00:00Z");

  it("expands a weekly rule in its VTIMEZONE, honouring EXDATE, moved and cancelled instances", () => {
    expect(starts(events, "Daily standup")).toEqual([
      "2026-11-09T08:00:00.000Z", // Mon, Kyiv is UTC+2 in November
      // Wed 11th is an EXDATE
      "2026-11-13T09:30:00.000Z", // Fri, moved from 10:00 to 11:30
      // Mon 16th is cancelled
      "2026-11-18T08:00:00.000Z"
    ]);
    const moved = events.find((event) => event.title === "Daily standup (moved)");
    expect(moved?.end.toISOString()).toBe("2026-11-13T09:45:00.000Z");
  });

  it("gives every occurrence its own key", () => {
    const keys = events.map((event) => event.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("stops a COUNT rule after its last occurrence", () => {
    expect(starts(events, "Vendor sync")).toEqual([
      "2026-11-09T15:00:00.000Z",
      "2026-11-10T15:00:00.000Z",
      "2026-11-11T15:00:00.000Z"
    ]);
  });

  it("keeps a lone instance of someone else's series", () => {
    const demo = events.find((event) => event.uid === "foreign-series@partner.example");
    expect(demo?.start.toISOString()).toBe("2026-11-12T15:00:00.000Z");
    expect(demo?.myStatus).toBe("tentative");
    expect(demo?.link?.provider).toBe("teams");
  });

  it("reads the organizer, attendees without rooms or the owner, and the Meet link", () => {
    const standup = events[0];
    expect(standup.myStatus).toBe("organizer");
    expect(standup.attendees).toEqual([{ email: "olena@example.com", name: "Olena Koval", status: "accepted" }]);
    expect(standup.link).toEqual({ provider: "meet", url: "https://meet.google.com/abc-defg-hij" });
    expect(standup.createdAt?.toISOString()).toBe("2026-09-01T09:00:00.000Z");
  });

  it("returns events sorted by start and only inside the window", () => {
    const narrow = parse("recurring.ics", "2026-11-13T00:00:00Z", "2026-11-14T00:00:00Z");
    expect(narrow.map((event) => event.title)).toEqual(["Daily standup (moved)"]);
  });
});

describe("parseCalendar — invites", () => {
  const events = parse("invites.ics", "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");

  it("reports the owner's answer from the feed's X-WR-CALNAME", () => {
    const status = Object.fromEntries(events.map((event) => [event.uid, event.myStatus]));
    expect(status).toEqual({
      "declined@example.com": "declined",
      "stale-invite@example.com": "needs-action",
      "fresh-invite@example.com": "needs-action"
    });
  });

  it("drops cancelled events", () => {
    expect(events.some((event) => event.uid === "cancelled@example.com")).toBe(false);
  });

  it("finds a Slack huddle in the location despite trailing punctuation", () => {
    const fresh = events.find((event) => event.uid === "fresh-invite@example.com");
    expect(fresh?.link).toEqual({ provider: "slack", url: "https://app.slack.com/huddle/T0123ABC/C0456DEF" });
  });

  it("does not know the owner's answer without an owner address", () => {
    const anonymous = parseCalendar(fixture("invites.ics").replace(/X-WR-CALNAME:.*\n/, ""), {
      from: new Date("2026-11-10T00:00:00Z"),
      to: new Date("2026-11-11T00:00:00Z")
    });
    expect(new Set(anonymous.map((event) => event.myStatus))).toEqual(new Set(["unknown"]));
  });
});

describe("parseCalendar — all-day", () => {
  const events = parse("all-day.ics", "2026-11-09T00:00:00Z", "2026-11-16T00:00:00Z");

  it("marks date-only events all-day and keeps them in local days", () => {
    const [dayOff, trip] = events;
    expect(dayOff).toMatchObject({ title: "Day off", allDay: true });
    expect(dayOff.start).toEqual(new Date(2026, 10, 10));
    expect(dayOff.end).toEqual(new Date(2026, 10, 11));
    expect(trip.start).toEqual(new Date(2026, 10, 12));
    expect(trip.end).toEqual(new Date(2026, 10, 15));
  });
});

describe("parseCalendar — time zones", () => {
  const events = parse("timezones.ics", "2026-10-28T00:00:00Z", "2026-11-11T00:00:00Z");
  const byUid = (uid: string): CalendarEvent[] => events.filter((event) => event.uid === uid);

  it("follows a VTIMEZONE across its DST change", () => {
    expect(byUid("ny-weekly@example.com").map((event) => event.start.toISOString())).toEqual([
      "2026-10-29T13:00:00.000Z", // EDT, UTC-4
      "2026-11-05T14:00:00.000Z" // EST, UTC-5
    ]);
  });

  it("resolves an IANA TZID the feed never defines", () => {
    expect(byUid("tokyo@example.com")[0].start.toISOString()).toBe("2026-11-10T00:00:00.000Z");
  });

  it("reads UTC and floating times", () => {
    expect(byUid("utc@example.com")[0].start.toISOString()).toBe("2026-11-10T12:00:00.000Z");
    expect(byUid("floating@example.com")[0].start).toEqual(new Date(2026, 10, 10, 9, 0));
  });
});
