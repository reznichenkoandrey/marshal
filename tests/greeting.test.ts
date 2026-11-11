import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GREET_AGAIN_MS,
  buildGreetingRequest,
  cleanGreeting,
  dayPart,
  greetingFallback,
  meetingToday,
  readLastGreeted,
  shouldGreet,
  writeLastGreeted
} from "../desktop/assistant/greeting.ts";

const at = (hours: number, minutes = 0) => new Date(2026, 10, 11, hours, minutes);

describe("dayPart", () => {
  it("splits the day at 5, 12, 17 and 23", () => {
    expect([4, 5, 11, 12, 16, 17, 22, 23].map((hour) => dayPart(at(hour)))).toEqual([
      "night", "morning", "morning", "afternoon", "afternoon", "evening", "evening", "night"
    ]);
  });
});

describe("shouldGreet", () => {
  it("greets once per 30 minutes, so a restart mid-work stays quiet", () => {
    expect(shouldGreet(1_000_000_000, 0)).toBe(true);
    expect(shouldGreet(1_000_000_000, 1_000_000_000 - GREET_AGAIN_MS + 1)).toBe(false);
    expect(shouldGreet(1_000_000_000, 1_000_000_000 - GREET_AGAIN_MS)).toBe(true);
  });
});

describe("meetingToday", () => {
  const now = at(9);
  it("keeps a meeting later today", () => {
    expect(meetingToday({ title: "Standup", start: at(10, 30) }, now)?.title).toBe("Standup");
  });
  it("drops meetings tomorrow, already started, or missing", () => {
    expect(meetingToday({ title: "Tomorrow", start: new Date(2026, 10, 12, 10) }, now)).toBeNull();
    expect(meetingToday({ title: "Started", start: at(8, 55) }, now)).toBeNull();
    expect(meetingToday(null, now)).toBeNull();
  });
});

describe("greetingFallback", () => {
  it("says only the facts that exist, in the UI language", () => {
    expect(greetingFallback({ lang: "uk", now: at(9), meeting: null, waiting: [] })).toBe("Доброго ранку. Що робимо сьогодні?");
    const full = greetingFallback({ lang: "en", now: at(14), meeting: { title: "Standup", start: at(15, 30) }, waiting: ["marshal", "snoriq"] });
    expect(full).toBe("Good afternoon. Standup at 15:30. Waiting for you: marshal, snoriq. What are we doing today?");
  });
});

describe("buildGreetingRequest", () => {
  it("asks for the UI language and passes the state as data", () => {
    const request = buildGreetingRequest({ lang: "uk", now: at(9), meeting: { title: "Standup", start: at(10) }, waiting: ["marshal"] });
    expect(request.system).toContain("Speak Ukrainian");
    expect(request.system).toContain("Never invent anything");
    expect(request.user).toContain('"Standup" at 10:00');
    expect(request.user).toContain("waiting for an answer: marshal");
  });
});

describe("cleanGreeting", () => {
  it("collapses whitespace and rejects empty or rambling replies", () => {
    expect(cleanGreeting("  Доброго ранку!\n Що робимо?  ")).toBe("Доброго ранку! Що робимо?");
    expect(cleanGreeting("")).toBeNull();
    expect(cleanGreeting(null)).toBeNull();
    expect(cleanGreeting("слово ".repeat(100))).toBeNull();
  });
});

describe("last greeted", () => {
  it("round-trips and reads a missing or broken file as never", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "marshal-greeting-")), "greeted.json");
    expect(readLastGreeted(file)).toBe(0);
    writeLastGreeted(file, 123);
    expect(readLastGreeted(file)).toBe(123);
  });
});
