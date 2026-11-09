import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CalendarService,
  fetchIcalFeed,
  normalizeIcalUrl,
  readIcalUrl,
  writeIcalUrl
} from "../desktop/calendar/calendar-service.ts";
import type { Reminder } from "../desktop/calendar/reminders.ts";

const SECRET_URL = "https://calendar.google.com/calendar/ical/owner%40example.com/private-0123456789abcdef/basic.ics";

const feed = (start: string): string => `BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:owner@example.com
BEGIN:VEVENT
UID:sync@example.com
DTSTART:${start}
DTEND:20261110T110000Z
SUMMARY:Sync
LOCATION:https://meet.google.com/abc-defg-hij
END:VEVENT
END:VCALENDAR`;

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-calendar-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("iCal address storage", () => {
  it("accepts https and webcal, refuses everything else", () => {
    expect(normalizeIcalUrl(` ${SECRET_URL} `)).toBe(SECRET_URL);
    expect(normalizeIcalUrl("webcal://example.com/a.ics")).toBe("https://example.com/a.ics");
    expect(normalizeIcalUrl("http://example.com/a.ics")).toBeNull();
    expect(normalizeIcalUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeIcalUrl("not a url")).toBeNull();
  });

  it("writes the address readable by the owner only and forgets it", () => {
    writeIcalUrl(dataDir, SECRET_URL);
    const file = path.join(dataDir, "calendar-ical-url");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readIcalUrl(dataDir)).toBe(SECRET_URL);
    writeIcalUrl(dataDir, null);
    expect(fs.existsSync(file)).toBe(false);
    expect(readIcalUrl(dataDir)).toBeNull();
  });

  it("tightens a file that already existed with looser permissions", () => {
    const file = path.join(dataDir, "calendar-ical-url");
    fs.writeFileSync(file, "x", { mode: 0o644 });
    writeIcalUrl(dataDir, SECRET_URL);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses an invalid address without echoing it", () => {
    const service = new CalendarService({ dataDir });
    expect(() => service.setUrl("http://leak.example/private-secret")).toThrow(/^Not a calendar address/);
    try {
      service.setUrl("http://leak.example/private-secret");
    } catch (err) {
      expect((err as Error).message).not.toContain("private-secret");
    }
  });
});

describe("fetchIcalFeed", () => {
  it("reports network failures and HTTP errors without the address", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new TypeError(`fetch failed ${SECRET_URL}`), { cause: { code: "ENOTFOUND" } })
    ));
    await expect(fetchIcalFeed(SECRET_URL)).rejects.toThrow("Calendar request failed (ENOTFOUND)");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));
    await expect(fetchIcalFeed(SECRET_URL)).rejects.toThrow("Calendar responded with HTTP 404");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>login</html>")));
    await expect(fetchIcalFeed(SECRET_URL)).rejects.toThrow("did not return an iCal feed");
  });
});

describe("CalendarService", () => {
  it("does nothing until started and nothing after stop", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-10T09:00:00Z") });
    writeIcalUrl(dataDir, SECRET_URL);
    const fetchText = vi.fn().mockResolvedValue(feed("20261110T100000Z"));
    const service = new CalendarService({ dataDir, fetchText });

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchText).not.toHaveBeenCalled();

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchText).toHaveBeenCalledTimes(2);

    service.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchText).toHaveBeenCalledTimes(2);
  });

  it("fires the 15 min, 5 min and start reminders on time", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-10T09:00:00Z") });
    writeIcalUrl(dataDir, SECRET_URL);
    const service = new CalendarService({
      dataDir,
      fetchText: vi.fn().mockResolvedValue(feed("20261110T100000Z"))
    });
    const fired: string[] = [];
    service.on("reminder", (reminder: Reminder) => fired.push(`${reminder.kind}@${new Date().toISOString()}`));

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.nextMeeting()?.title).toBe("Sync");
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    service.stop();

    expect(fired).toEqual([
      "before-15@2026-11-10T09:45:00.000Z",
      "before-5@2026-11-10T09:55:00.000Z",
      "start@2026-11-10T10:00:00.000Z"
    ]);
  });

  it("keeps the last good events when a refresh fails and reports a safe error", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-10T09:00:00Z") });
    writeIcalUrl(dataDir, SECRET_URL);
    const fetchText = vi.fn()
      .mockResolvedValueOnce(feed("20261110T100000Z"))
      .mockRejectedValue(new Error(`boom ${SECRET_URL}`));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new CalendarService({ dataDir, fetchText });

    service.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(service.nextMeeting()?.title).toBe("Sync");
    service.stop();

    expect(service.status().lastError).toBe("Calendar feed could not be read");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-0123456789abcdef");
    warn.mockRestore();
  });
});
