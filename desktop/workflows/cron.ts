// Five-field cron rules (`minute hour dom month dow`) evaluated in a named
// time zone (#280). Pure: the scheduler asks only for the next instant.

export interface CronRule {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** Vixie rule: when both day fields are restricted, either one matching is enough. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELDS: ReadonlyArray<{ min: number; max: number }> = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 }
];

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
// Feb 29 on a given weekday can be decades apart; eight years covers every rule that names a real date.
const SEARCH_DAYS = 366 * 8;

function parseField(text: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return null;
    let from = min;
    let to = max;
    if (range !== "*") {
      const [a, b] = range.split("-").map(Number);
      from = a;
      to = b ?? (stepText === undefined ? a : max);
    }
    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** Parses a cron expression; null when it is not five valid numeric fields. */
export function parseCron(expression: string): CronRule | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) return null;
  const parsed = parts.map((part, index) => parseField(part, FIELDS[index].min, FIELDS[index].max));
  if (parsed.some((field) => field === null)) return null;
  const [minutes, hours, daysOfMonth, months, dow] = parsed as number[][];
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    // 7 is Sunday too.
    daysOfWeek: [...new Set(dow.map((day) => day % 7))].sort((a, b) => a - b),
    domRestricted: !parts[2].startsWith("*"),
    dowRestricted: !parts[4].startsWith("*")
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's wall clock at `instant`, expressed as if it were UTC milliseconds. */
export function wallClock(instant: number, timeZone: string): number {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function offsetAt(instant: number, timeZone: string): number {
  return wallClock(instant, timeZone) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in the zone. A time inside a
 * spring-forward gap maps to the same distance after the gap (02:30 becomes
 * 03:30), so a daily rule still runs that day; a time repeated by fall-back
 * maps to one of the two instants, so it runs once.
 */
export function wallToInstant(wall: number, timeZone: string): number {
  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  if (wallClock(second, timeZone) === wall) return second;
  if (wallClock(first, timeZone) === wall) return first;
  return Math.max(first, second);
}

function dayMatches(rule: CronRule, dayStart: number): boolean {
  const date = new Date(dayStart);
  if (!rule.months.includes(date.getUTCMonth() + 1)) return false;
  const dom = rule.daysOfMonth.includes(date.getUTCDate());
  const dow = rule.daysOfWeek.includes(date.getUTCDay());
  if (rule.domRestricted && rule.dowRestricted) return dom || dow;
  return dom && dow;
}

/** The first instant strictly after `after` that matches the rule; null when none exists within eight years. */
export function nextRunAt(rule: CronRule, timeZone: string, after: number): number | null {
  const localNow = wallClock(after, timeZone);
  const firstDay = Math.floor(localNow / DAY_MS) * DAY_MS;
  // One day back: around a DST change an instant after `after` can carry yesterday's wall date.
  for (let offset = -1; offset < SEARCH_DAYS; offset++) {
    const dayStart = firstDay + offset * DAY_MS;
    if (!dayMatches(rule, dayStart)) continue;
    let best: number | null = null;
    for (const hour of rule.hours) {
      for (const minute of rule.minutes) {
        const instant = wallToInstant(dayStart + hour * 3_600_000 + minute * MINUTE_MS, timeZone);
        if (instant > after && (best === null || instant < best)) best = instant;
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/** True when the rule fires at most once a day (one fixed hour and minute). */
export function isDailyOrRarer(rule: CronRule): boolean {
  return rule.hours.length === 1 && rule.minutes.length === 1;
}
