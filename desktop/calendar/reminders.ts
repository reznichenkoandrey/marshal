// When to remind about a meeting and what the reminder says. Pure: the
// service owns the clock and the timers, this decides.

import type { CalendarEvent } from "./ical-events.ts";
import type { MeetingProvider } from "./meeting-links.ts";

export type ReminderKind = "before-15" | "before-5" | "start";
export type ReminderLanguage = "uk" | "en";

export type Reminder = {
  kind: ReminderKind;
  at: Date;
  event: CalendarEvent;
};

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const LEADS: ReadonlyArray<{ kind: ReminderKind; leadMs: number }> = [
  { kind: "before-15", leadMs: 15 * MINUTE_MS },
  { kind: "before-5", leadMs: 5 * MINUTE_MS },
  { kind: "start", leadMs: 0 }
];

/** Invites nobody answered for this long are treated as not attending. */
export const STALE_INVITE_MS = 14 * DAY_MS;

/**
 * How late a reminder may still fire — after sleep, or when Marshal starts a
 * couple of minutes into a meeting, a "Join" is still useful; an hour late it
 * is noise.
 */
export const CATCH_UP_MS = 5 * MINUTE_MS;

export function shouldRemind(event: CalendarEvent, now: Date): boolean {
  if (event.allDay) return false;
  if (event.myStatus === "declined") return false;
  if (
    event.myStatus === "needs-action" &&
    event.createdAt !== null &&
    now.getTime() - event.createdAt.getTime() >= STALE_INVITE_MS
  ) {
    return false;
  }
  return true;
}

function remindersOf(event: CalendarEvent): Reminder[] {
  return LEADS.map(({ kind, leadMs }) => ({
    kind,
    at: new Date(event.start.getTime() - leadMs),
    event
  }));
}

/**
 * Reminders that came due in (since, now], at most one per meeting — when
 * several are due at once (Marshal just started, or the Mac woke up) only the
 * latest one is worth showing.
 */
export function dueReminders(events: CalendarEvent[], since: Date, now: Date): Reminder[] {
  const floor = Math.max(since.getTime(), now.getTime() - CATCH_UP_MS);
  const due: Reminder[] = [];
  for (const event of events) {
    if (!shouldRemind(event, now)) continue;
    const latest = remindersOf(event)
      .filter((reminder) => reminder.at.getTime() > floor && reminder.at.getTime() <= now.getTime())
      .at(-1);
    if (latest) due.push(latest);
  }
  return due;
}

export function nextReminderAt(events: CalendarEvent[], now: Date): Date | null {
  let next: number | null = null;
  for (const event of events) {
    if (!shouldRemind(event, now)) continue;
    for (const reminder of remindersOf(event)) {
      const at = reminder.at.getTime();
      if (at > now.getTime() && (next === null || at < next)) next = at;
    }
  }
  return next === null ? null : new Date(next);
}

/** The meeting in progress, or else the next one to start. */
export function nextMeeting(events: CalendarEvent[], now: Date): CalendarEvent | null {
  return (
    events
      .filter((event) => shouldRemind(event, now) && event.end.getTime() > now.getTime())
      .sort((a, b) => a.start.getTime() - b.start.getTime())[0] ?? null
  );
}

export function pickLanguage(preferred: readonly string[]): ReminderLanguage {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (base === "uk" || base === "en") return base;
  }
  return "en";
}

const PROVIDER_NAMES: Record<MeetingProvider, string> = {
  meet: "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
  slack: "Slack huddle"
};

const TEXT = {
  uk: {
    inMinutes: (minutes: number) => `За ${minutes} хв`,
    startingNow: "Починається",
    now: "Зараз",
    next: "Далі",
    noLink: "без посилання",
    join: "Приєднатися",
    joinAndRecord: "Приєднатися + запис",
    locale: "uk-UA"
  },
  en: {
    inMinutes: (minutes: number) => `In ${minutes} min`,
    startingNow: "Starting now",
    now: "Now",
    next: "Next",
    noLink: "no link",
    join: "Join",
    joinAndRecord: "Join + Record",
    locale: "en-GB"
  }
} as const;

export function actionLabels(lang: ReminderLanguage): { join: string; joinAndRecord: string } {
  return { join: TEXT[lang].join, joinAndRecord: TEXT[lang].joinAndRecord };
}

export function formatTime(date: Date, lang: ReminderLanguage, now: Date): string {
  const sameDay = date.toDateString() === now.toDateString();
  return date.toLocaleString(TEXT[lang].locale, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function reminderText(
  reminder: Reminder,
  lang: ReminderLanguage,
  now: Date
): { title: string; body: string } {
  const text = TEXT[lang];
  const { event } = reminder;
  const minutesLeft = Math.round((event.start.getTime() - now.getTime()) / MINUTE_MS);
  const lead = reminder.kind === "start" || minutesLeft <= 0 ? text.startingNow : text.inMinutes(minutesLeft);

  const others = event.attendees.filter((attendee) => attendee.status !== "declined" && attendee.name);
  const shown = others.slice(0, 3).map((attendee) => attendee.name);
  if (others.length > shown.length) shown.push(`+${others.length - shown.length}`);

  const body = [
    formatTime(event.start, lang, now),
    event.link ? PROVIDER_NAMES[event.link.provider] : text.noLink,
    shown.join(", ")
  ].filter(Boolean).join(" · ");

  return { title: `${lead}: ${event.title}`, body };
}

export function trayLabel(event: CalendarEvent, lang: ReminderLanguage, now: Date): string {
  const text = TEXT[lang];
  const prefix = event.start.getTime() <= now.getTime() ? text.now : text.next;
  return `${prefix}: ${formatTime(event.start, lang, now)} ${event.title}`;
}
