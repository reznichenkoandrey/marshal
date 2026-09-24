// tests/capture-history-list.test.ts
//
// The history grid reads two sources — the user's capture folder and the
// archive in userData — and a capture saved without annotation exists in both.
// These pin the ordering, the cap and the de-duplication rule that keeps one
// screenshot from showing up as two tiles. See #225.

import { describe, expect, it } from "vitest";

import {
  HISTORY_LIST_LIMIT,
  mergeHistoryEntries,
  type CaptureHistoryEntry
} from "../desktop/capture/capture-history-list.ts";

function make(over: Partial<CaptureHistoryEntry> & { name: string; modifiedAt: number }): CaptureHistoryEntry {
  return {
    path: `/x/${over.name}`,
    kind: "image",
    bytes: 1_000,
    source: "folder",
    ...over
  };
}

describe("mergeHistoryEntries", () => {
  it("returns both sources newest first", () => {
    const merged = mergeHistoryEntries(
      [make({ name: "saved.png", modifiedAt: 1_000, bytes: 10 })],
      [make({ name: "archived.png", modifiedAt: 2_000, bytes: 20, source: "archive" })]
    );
    expect(merged.map((e) => e.name)).toEqual(["archived.png", "saved.png"]);
  });

  it("collapses the same capture stored in both places, keeping the folder copy", () => {
    const at = Date.UTC(2026, 8, 24, 19, 26, 5);
    const merged = mergeHistoryEntries(
      [make({ name: "Marshal 2026-09-24 19.26.05.png", modifiedAt: at, bytes: 48_120 })],
      [
        make({
          name: "Marshal 2026-09-24 19.26.05 area.png",
          modifiedAt: at + 400,
          bytes: 48_120,
          source: "archive"
        })
      ]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("folder");
  });

  it("keeps an annotated export alongside the original it came from", () => {
    // Annotations change the byte count, so this must stay two entries — the
    // whole point of history is getting back to either one.
    const at = Date.UTC(2026, 8, 24, 19, 26, 5);
    const merged = mergeHistoryEntries(
      [make({ name: "annotated.png", modifiedAt: at, bytes: 52_004 })],
      [make({ name: "original.png", modifiedAt: at, bytes: 48_120, source: "archive" })]
    );
    expect(merged).toHaveLength(2);
  });

  it("does not collapse same-size captures taken minutes apart", () => {
    const merged = mergeHistoryEntries(
      [make({ name: "a.png", modifiedAt: 0, bytes: 2_048 })],
      [make({ name: "b.png", modifiedAt: 5 * 60_000, bytes: 2_048, source: "archive" })]
    );
    expect(merged).toHaveLength(2);
  });

  it("does not collapse a video against a same-size image", () => {
    const at = Date.UTC(2026, 8, 24, 19, 26, 5);
    const merged = mergeHistoryEntries(
      [make({ name: "clip.mov", modifiedAt: at, bytes: 9_000, kind: "video" })],
      [make({ name: "shot.png", modifiedAt: at, bytes: 9_000, source: "archive" })]
    );
    expect(merged).toHaveLength(2);
  });

  it("caps the list at the newest entries", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      make({ name: `${i}.png`, modifiedAt: i * 60_000, bytes: i + 1 })
    );
    const merged = mergeHistoryEntries(many, [], 3);
    expect(merged.map((e) => e.name)).toEqual(["11.png", "10.png", "9.png"]);
  });

  it("defaults to the shipped limit", () => {
    expect(HISTORY_LIST_LIMIT).toBe(300);
    const many = Array.from({ length: HISTORY_LIST_LIMIT + 5 }, (_, i) =>
      make({ name: `${i}.png`, modifiedAt: i * 60_000, bytes: i + 1 })
    );
    expect(mergeHistoryEntries(many, [])).toHaveLength(HISTORY_LIST_LIMIT);
  });
});
