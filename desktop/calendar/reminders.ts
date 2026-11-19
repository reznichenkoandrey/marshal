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

// ── Typed and spoken reminders (#270) ─────────────────────────────────────
// Same clock rules as meeting reminders above: the service owns timers and
// persistence; these functions decide what a phrase means and when it fires.

export type ReminderTrigger = { kind: "at"; at: number } | { kind: "session"; session: string };

export type TimedReminder = {
  id: string;
  text: string;
  trigger: ReminderTrigger;
  createdAt: number;
  done: boolean;
};

const DURATION_PATTERNS: ReadonlyArray<{ pattern: RegExp; unitMs: number }> = [
  { pattern: /^(?:remind me )?in (\d{1,4}) ?(?:min|mins|minutes?)$/i, unitMs: MINUTE_MS },
  { pattern: /^(?:remind me )?in (\d{1,3}) ?(?:h|hr|hrs|hours?)$/i, unitMs: 60 * MINUTE_MS },
  { pattern: /^(?:через|за) (\d{1,4}) ?(?:хв|хвилин[уи]?)$/iu, unitMs: MINUTE_MS },
  { pattern: /^(?:через|за) (\d{1,3}) ?(?:год|годин[уи]?)$/iu, unitMs: 60 * MINUTE_MS }
];

const SESSION_PATTERNS: readonly RegExp[] = [
  /^after (.+)$/i,
  /^коли (?:сесія |сесія)?(.+?) (?:закінчиться|завершиться|скінчиться)$/iu
];

/**
 * Reads a reminder phrase: `in 30 min`, `через 2 год`, `after <session>`,
 * `коли <сесія> закінчиться`. Null when the phrase is none of these — the
 * caller then tries other readings instead of guessing a time.
 */
export function parseReminderPhrase(input: string, now: number): ReminderTrigger | null {
  const phrase = input.trim().replace(/\s+/g, " ");
  if (phrase === "") return null;
  for (const { pattern, unitMs } of DURATION_PATTERNS) {
    const match = phrase.match(pattern);
    if (match) {
      const amount = Number(match[1]);
      if (amount <= 0) return null;
      return { kind: "at", at: now + amount * unitMs };
    }
  }
  for (const pattern of SESSION_PATTERNS) {
    const match = phrase.match(pattern);
    if (match && match[1].trim() !== "") return { kind: "session", session: match[1].trim() };
  }
  return null;
}

/** A session that went from busy to idle has finished its turn. */
export function sessionFinished(previous: string | null, next: string | null): boolean {
  return previous === "busy" && next === "idle";
}

/**
 * Reminders that fire now: time has come, or the named session just finished.
 * Done reminders never fire again; the caller marks them done after delivery.
 */
export function dueTimedReminders(
  reminders: readonly TimedReminder[],
  now: number,
  finishedSessions: ReadonlySet<string>
): TimedReminder[] {
  return reminders.filter((reminder) => {
    if (reminder.done) return false;
    if (reminder.trigger.kind === "at") return reminder.trigger.at <= now;
    return finishedSessions.has(reminder.trigger.session);
  });
}

/** Reads the persisted list; anything malformed is dropped rather than failing the whole file. */
export function parseStoredReminders(raw: unknown): TimedReminder[] {
  if (!Array.isArray(raw)) return [];
  const out: TimedReminder[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const trigger = r.trigger as Record<string, unknown> | undefined;
    if (typeof r.id !== "string" || typeof r.text !== "string" || !trigger) continue;
    if (trigger.kind === "at" && typeof trigger.at === "number" && Number.isFinite(trigger.at)) {
      out.push({ id: r.id, text: r.text, trigger: { kind: "at", at: trigger.at }, createdAt: Number(r.createdAt) || 0, done: r.done === true });
    } else if (trigger.kind === "session" && typeof trigger.session === "string" && trigger.session !== "") {
      out.push({ id: r.id, text: r.text, trigger: { kind: "session", session: trigger.session }, createdAt: Number(r.createdAt) || 0, done: r.done === true });
    }
  }
  return out;
}
