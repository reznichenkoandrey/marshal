// Turns an iCal feed (Google Calendar's "secret address in iCal format") into
// the concrete meetings inside a time window. ical.js does the RFC 5545 work —
// RRULE/EXDATE expansion, RECURRENCE-ID overrides, VTIMEZONE offsets — which
// is too easy to get subtly wrong by hand; this module only decides what a
// meeting is for Marshal: its real start, the owner's answer and the join link.

import ICAL from "ical.js";

import { extractMeetingLink, type MeetingLink } from "./meeting-links.ts";

type IcalComponent = InstanceType<typeof ICAL.Component>;
type IcalEvent = InstanceType<typeof ICAL.Event>;
type IcalTime = InstanceType<typeof ICAL.Time>;

export type AttendeeStatus = "accepted" | "declined" | "tentative" | "needs-action" | "unknown";

export type CalendarAttendee = {
  email: string;
  name: string;
  status: AttendeeStatus;
};

export type CalendarEvent = {
  /** Unique per occurrence: the same recurring meeting on two days has two keys. */
  key: string;
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string;
  attendees: CalendarAttendee[];
  /** The calendar owner's answer; "organizer" when they sent the invite. */
  myStatus: AttendeeStatus | "organizer";
  createdAt: Date | null;
  link: MeetingLink | null;
};

export type ParseOptions = {
  from: Date;
  to: Date;
  /** Defaults to the feed's X-WR-CALNAME, which Google sets to the owner's address. */
  ownerEmail?: string;
};

// Guard against pathological rules only: a daily meeting started ten years
// ago is ~3,650 iterations, which is still cheap every few minutes.
const MAX_OCCURRENCES = 50_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PARTSTAT: Record<string, AttendeeStatus> = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
  "NEEDS-ACTION": "needs-action"
};

export function parseCalendar(ics: string, options: ParseOptions): CalendarEvent[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const zone of root.getAllSubcomponents("vtimezone")) {
    ICAL.TimezoneService.register(zone);
  }
  const owner = normalizeEmail(options.ownerEmail ?? String(root.getFirstPropertyValue("x-wr-calname") ?? ""));
  const fromMs = options.from.getTime();
  const toMs = options.to.getTime();

  const byUid = new Map<string, IcalComponent[]>();
  for (const component of root.getAllSubcomponents("vevent")) {
    const uid = String(component.getFirstPropertyValue("uid") ?? "");
    const group = byUid.get(uid) ?? [];
    group.push(component);
    byUid.set(uid, group);
  }

  const events: CalendarEvent[] = [];
  const emit = (item: IcalEvent, startTime: IcalTime, endTime: IcalTime): void => {
    if (isCancelled(item.component)) return;
    const start = toDate(startTime);
    const end = toDate(endTime);
    if (end.getTime() <= fromMs || start.getTime() >= toMs) return;
    events.push(toCalendarEvent(item, start, end, startTime.isDate, owner));
  };

  for (const group of byUid.values()) {
    const master = group.find((component) => !component.hasProperty("recurrence-id"));
    const overrides = group.filter((component) => component !== master);
    if (!master) {
      // Invited to a single instance of someone else's series: the feed has
      // only the override, with no rule to expand.
      for (const override of overrides) {
        const item = new ICAL.Event(override);
        emit(item, item.startDate, item.endDate);
      }
      continue;
    }
    if (isCancelled(master)) continue;

    const event = new ICAL.Event(master);
    for (const override of overrides) event.relateException(override);
    if (!event.isRecurring()) {
      emit(event, event.startDate, event.endDate);
      continue;
    }

    const iterator = event.iterator();
    for (let i = 0; i < MAX_OCCURRENCES; i += 1) {
      const next = iterator.next();
      if (!next) break;
      // An override may move an occurrence by a few days in either direction,
      // so keep walking a little past the window before stopping.
      if (toDate(next).getTime() > toMs + 7 * DAY_MS) break;
      const details = event.getOccurrenceDetails(next);
      emit(details.item, details.startDate, details.endDate);
    }
  }

  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function toCalendarEvent(
  item: IcalEvent,
  start: Date,
  end: Date,
  allDay: boolean,
  owner: string
): CalendarEvent {
  const component = item.component;
  const attendees: CalendarAttendee[] = [];
  for (const property of item.attendees) {
    const cutype = String(property.getParameter("cutype") ?? "").toUpperCase();
    if (cutype === "RESOURCE" || cutype === "ROOM") continue;
    const email = normalizeEmail(String(property.getFirstValue() ?? ""));
    const partstat = String(property.getParameter("partstat") ?? "").toUpperCase();
    attendees.push({
      email,
      name: String(property.getParameter("cn") ?? email),
      status: PARTSTAT[partstat] ?? "unknown"
    });
  }

  let myStatus: CalendarEvent["myStatus"] = "unknown";
  if (owner && normalizeEmail(item.organizer ?? "") === owner) {
    myStatus = "organizer";
  } else if (owner) {
    myStatus = attendees.find((attendee) => attendee.email === owner)?.status ?? "unknown";
  }

  const created = component.getFirstPropertyValue("created");
  const conference = component.getFirstPropertyValue("x-google-conference");
  const urlProperty = component.getFirstPropertyValue("url");

  return {
    key: `${item.uid}|${start.toISOString()}`,
    uid: item.uid,
    title: item.summary?.trim() || "(no title)",
    start,
    end,
    allDay,
    location: item.location ?? "",
    // The owner is on every invite; listing them in a reminder says nothing.
    attendees: attendees.filter((attendee) => attendee.email !== owner),
    myStatus,
    createdAt: created instanceof ICAL.Time ? toDate(created) : null,
    link: extractMeetingLink([
      typeof conference === "string" ? conference : null,
      item.location,
      item.description,
      typeof urlProperty === "string" ? urlProperty : null
    ])
  };
}

function isCancelled(component: IcalComponent): boolean {
  return String(component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";
}

function normalizeEmail(value: string): string {
  const email = value.replace(/^mailto:/i, "").trim().toLowerCase();
  return email.includes("@") ? email : "";
}

/**
 * ical.js resolves a TZID only against VTIMEZONE blocks in the feed; without
 * one the time is treated as floating, i.e. read in the Mac's own zone. Feeds
 * do reference zones they never define, so an IANA name falls back to Intl.
 */
export function toDate(time: IcalTime): Date {
  // ical.js keeps the raw TZID on the instance but leaves it out of its typings.
  const tzid = (time as IcalTime & { timezone?: string }).timezone;
  if (time.isDate || !tzid || time.zone?.tzid !== "floating") return time.toJSDate();
  return zonedTimeToDate(time, tzid) ?? time.toJSDate();
}

function zonedTimeToDate(time: IcalTime, tzid: string): Date | null {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    });
  } catch {
    return null;
  }
  const offsetAt = (ms: number): number => {
    const parts = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
    const wall = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    return wall - ms;
  };
  const wallAsUtc = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  // Two passes: the first guess can land on the other side of a DST switch.
  const guess = wallAsUtc - offsetAt(wallAsUtc);
  return new Date(wallAsUtc - offsetAt(guess));
}
