// Fetches the private iCal feed and fires meeting reminders (#269). Holds no
// timer while stopped: the feature is off by default and must cost nothing
// then (budget #281).
//
// The iCal address is a bearer secret — anyone with it reads the whole
// calendar. It lives in its own 0600 file in userData, is never returned to
// the renderer, and never appears in a log line or an error message.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { parseCalendar, type CalendarEvent } from "./ical-events.ts";
import { CATCH_UP_MS, dueReminders, nextMeeting, nextReminderAt, type Reminder } from "./reminders.ts";

const URL_FILE = "calendar-ical-url";
const REFRESH_INTERVAL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FEED_BYTES = 20 * 1024 * 1024;
const HOUR_MS = 60 * 60_000;
// Long enough for the tray's "next meeting" to look past tonight.
const LOOKAHEAD_MS = 26 * HOUR_MS;
const MAX_TIMER_MS = 2_147_483_647;

export type CalendarStatus = {
  configured: boolean;
  running: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
};

export type FetchText = (url: string) => Promise<string>;

/** Accepts the https:// or webcal:// address Google shows; anything else is refused. */
export function normalizeIcalUrl(input: string): string | null {
  const trimmed = input.trim().replace(/^webcals?:\/\//i, "https://");
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

export function readIcalUrl(dataDir: string): string | null {
  try {
    return normalizeIcalUrl(fs.readFileSync(path.join(dataDir, URL_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** Saves the address (0600), or forgets it when `url` is null. */
export function writeIcalUrl(dataDir: string, url: string | null): void {
  const file = path.join(dataDir, URL_FILE);
  if (url === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, url, { encoding: "utf8", mode: 0o600 });
  // `mode` applies only when the file is created.
  fs.chmodSync(file, 0o600);
}

export async function fetchIcalFeed(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "text/calendar" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (err) {
    // The error text from undici can carry the request URL; report the kind only.
    throw new Error(`Calendar request failed (${describeNetworkError(err)})`);
  }
  if (!response.ok) throw new Error(`Calendar responded with HTTP ${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_FEED_BYTES) {
    throw new Error("Calendar feed is too large");
  }
  const text = await response.text();
  if (text.length > MAX_FEED_BYTES) throw new Error("Calendar feed is too large");
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("The address did not return an iCal feed");
  return text;
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "network error";
}

type CalendarServiceEvents = {
  reminder: [Reminder];
};

export class CalendarService extends EventEmitter<CalendarServiceEvents> {
  private readonly dataDir: string;
  private readonly fetchText: FetchText;
  private readonly now: () => Date;
  private running = false;
  private events: CalendarEvent[] = [];
  private remindedUpTo = new Date(0);
  private refreshTimer: NodeJS.Timeout | null = null;
  private reminderTimer: NodeJS.Timeout | null = null;
  private lastSyncAt: Date | null = null;
  private lastError: string | null = null;
  private generation = 0;

  constructor(options: { dataDir: string; fetchText?: FetchText; now?: () => Date }) {
    super();
    this.dataDir = options.dataDir;
    this.fetchText = options.fetchText ?? fetchIcalFeed;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // A meeting that started a minute before launch still gets its Join.
    this.remindedUpTo = new Date(this.now().getTime() - CATCH_UP_MS);
    void this.refresh();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    this.events = [];
  }

  isConfigured(): boolean {
    return readIcalUrl(this.dataDir) !== null;
  }

  /** Throws on an address that is not https/webcal; the message never echoes it. */
  setUrl(input: string): void {
    if (input.trim() === "") {
      writeIcalUrl(this.dataDir, null);
      this.events = [];
      this.lastError = null;
      this.lastSyncAt = null;
      return;
    }
    const url = normalizeIcalUrl(input);
    if (!url) throw new Error("Not a calendar address: expected an https:// or webcal:// URL");
    writeIcalUrl(this.dataDir, url);
    if (this.running) void this.refresh();
  }

  status(): CalendarStatus {
    return {
      configured: this.isConfigured(),
      running: this.running,
      lastSyncAt: this.lastSyncAt?.toISOString() ?? null,
      lastError: this.lastError
    };
  }

  nextMeeting(): CalendarEvent | null {
    return nextMeeting(this.events, this.now());
  }

  async refresh(): Promise<void> {
    if (!this.running) return;
    const generation = ++this.generation;
    this.clearTimers();
    const url = readIcalUrl(this.dataDir);
    if (url) {
      try {
        const ics = await this.fetchText(url);
        if (generation !== this.generation) return;
        const now = this.now();
        this.events = parseCalendar(ics, {
          from: new Date(now.getTime() - HOUR_MS),
          to: new Date(now.getTime() + LOOKAHEAD_MS)
        });
        this.lastSyncAt = now;
        this.lastError = null;
      } catch (err) {
        if (generation !== this.generation) return;
        // Keep the last good events: a flaky network should not drop reminders.
        this.lastError = err instanceof Error && err.message.startsWith("Calendar")
          ? err.message
          : "Calendar feed could not be read";
        console.warn(`[marshal] calendar: ${this.lastError}`);
      }
    } else {
      this.events = [];
    }
    this.fireDue();
    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_INTERVAL_MS);
  }

  private fireDue(): void {
    if (!this.running) return;
    const now = this.now();
    const due = dueReminders(this.events, this.remindedUpTo, now);
    this.remindedUpTo = now;
    for (const reminder of due) this.emit("reminder", reminder);

    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.reminderTimer = null;
    const next = nextReminderAt(this.events, now);
    if (next) {
      const delay = Math.min(Math.max(next.getTime() - now.getTime(), 0), MAX_TIMER_MS);
      this.reminderTimer = setTimeout(() => this.fireDue(), delay);
    }
  }

  private clearTimers(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.refreshTimer = null;
    this.reminderTimer = null;
  }
}
