// tests/capture-history-filter.test.ts
//
// Search and day grouping for the capture history grid. What matters here is
// that the text the heading shows is the text the search box matches, and that
// the day a capture lands in is its LOCAL day — `toISOString()` is UTC and
// would file an evening capture under tomorrow. See #225.

import { describe, expect, it } from "vitest";

import {
  dayLabel,
  filterEntries,
  groupByDay,
  isoDay,
  kindLabel,
  matchesQuery
} from "../desktop/renderer/capture-history-filter.js";

const NOW = new Date(2026, 8, 24, 14, 0, 0).getTime();
const at = (...args: [number, number, number, number?, number?]) =>
  new Date(args[0], args[1], args[2], args[3] ?? 12, args[4] ?? 0).getTime();

function make(over: { name: string; modifiedAt: number; kind?: string; source?: string }) {
  return { path: `/x/${over.name}`, bytes: 1_000, kind: "image", source: "archive", ...over };
}

describe("kindLabel", () => {
  it("shows images as PNG and everything else by its kind", () => {
    expect(kindLabel("image")).toBe("PNG");
    expect(kindLabel("video")).toBe("VIDEO");
    expect(kindLabel("gif")).toBe("GIF");
    expect(kindLabel(undefined)).toBe("");
  });
});

describe("isoDay", () => {
  it("uses the local day, not UTC", () => {
    // 23:30 local on the 24th is already the 25th in UTC for a +02:00 offset;
    // the capture still belongs to the 24th as far as the user is concerned.
    expect(isoDay(at(2026, 8, 24, 23, 30))).toBe("2026-09-24");
    expect(isoDay(at(2026, 0, 2, 0, 5))).toBe("2026-01-02");
  });
});

describe("dayLabel", () => {
  it("names today and yesterday", () => {
    expect(dayLabel(at(2026, 8, 24, 9, 0), NOW)).toBe("Today");
    expect(dayLabel(at(2026, 8, 24, 23, 59), NOW)).toBe("Today");
    expect(dayLabel(at(2026, 8, 23, 22, 0), NOW)).toBe("Yesterday");
  });

  it("falls back to the ISO date once past a week, so the heading is searchable", () => {
    expect(dayLabel(at(2026, 8, 10), NOW)).toBe("2026-09-10");
  });

  it("uses a weekday name inside the last week", () => {
    expect(dayLabel(at(2026, 8, 21), NOW)).toBe(
      new Date(at(2026, 8, 21)).toLocaleDateString(undefined, { weekday: "long" })
    );
  });
});

describe("matchesQuery", () => {
  const entry = make({ name: "Marshal 2026-09-24 19.26.05 area.png", modifiedAt: at(2026, 8, 24, 19, 26) });

  it("matches everything when the query is empty", () => {
    expect(matchesQuery(entry, "", NOW)).toBe(true);
    expect(matchesQuery(entry, "   ", NOW)).toBe(true);
    expect(matchesQuery(entry, undefined, NOW)).toBe(true);
  });

  it("matches the filename, case-insensitively", () => {
    expect(matchesQuery(entry, "AREA", NOW)).toBe(true);
    expect(matchesQuery(entry, "19.26", NOW)).toBe(true);
    expect(matchesQuery(entry, "fullscreen", NOW)).toBe(false);
  });

  it("matches the badge and the day heading the tile shows", () => {
    expect(matchesQuery(entry, "png", NOW)).toBe(true);
    expect(matchesQuery(entry, "today", NOW)).toBe(true);
    expect(matchesQuery(entry, "yesterday", NOW)).toBe(false);
  });

  it("matches the ISO date even for a capture labelled Today", () => {
    expect(matchesQuery(entry, "2026-09-24", NOW)).toBe(true);
  });

  it("requires every term, in any order", () => {
    expect(matchesQuery(entry, "png today", NOW)).toBe(true);
    expect(matchesQuery(entry, "today png", NOW)).toBe(true);
    expect(matchesQuery(entry, "png tomorrow", NOW)).toBe(false);
  });
});

describe("filterEntries", () => {
  const entries = [
    make({ name: "Marshal 2026-09-24 19.26.05 area.png", modifiedAt: at(2026, 8, 24, 19, 26) }),
    make({ name: "Marshal 2026-09-23 08.10.00 fullscreen.png", modifiedAt: at(2026, 8, 23, 8, 10) }),
    make({ name: "Marshal 2026-09-20 11.00.00.mov", modifiedAt: at(2026, 8, 20, 11, 0), kind: "video" })
  ];

  it("narrows by day", () => {
    expect(filterEntries(entries, "yesterday", NOW).map((e) => e.name)).toEqual([
      "Marshal 2026-09-23 08.10.00 fullscreen.png"
    ]);
  });

  it("narrows by kind", () => {
    expect(filterEntries(entries, "video", NOW)).toHaveLength(1);
    expect(filterEntries(entries, "png", NOW)).toHaveLength(2);
  });

  it("returns an empty list for a non-array input rather than throwing", () => {
    expect(filterEntries(null, "x", NOW)).toEqual([]);
  });
});

describe("groupByDay", () => {
  it("buckets by local day, newest day and newest entry first", () => {
    const groups = groupByDay(
      [
        make({ name: "morning.png", modifiedAt: at(2026, 8, 24, 9, 0) }),
        make({ name: "older.png", modifiedAt: at(2026, 8, 23, 20, 0) }),
        make({ name: "evening.png", modifiedAt: at(2026, 8, 24, 19, 0) })
      ],
      NOW
    );

    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[0].entries.map((e) => e.name)).toEqual(["evening.png", "morning.png"]);
    expect(groups[1].entries.map((e) => e.name)).toEqual(["older.png"]);
  });

  it("produces no empty groups", () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });

  it("keeps a late-evening capture on its own local day", () => {
    const groups = groupByDay([make({ name: "late.png", modifiedAt: at(2026, 8, 24, 23, 45) })], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Today");
  });
});
