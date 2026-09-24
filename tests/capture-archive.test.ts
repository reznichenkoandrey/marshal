// tests/capture-archive.test.ts
//
// Retention is the part of the capture archive that can quietly go wrong: it
// deletes files. The caps are pinned here, plus the two rules that keep the
// archive honest — two captures inside the same second must not overwrite each
// other, and `replace` must refuse anything outside the archive folder so a
// re-edit can never rewrite a file the user saved themselves. See #225.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_MAX_ENTRIES,
  CaptureArchive,
  archiveFileName,
  planPrune,
  type ArchivedCapture
} from "../desktop/capture/capture-archive.ts";

/** 1×1 transparent PNG — small, valid, and irrelevant to what is asserted. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wFBBAgAAAAASUVORK5CYII=";

function entry(over: Partial<ArchivedCapture> & { modifiedAt: number }): ArchivedCapture {
  return {
    path: `/tmp/${over.modifiedAt}.png`,
    name: `${over.modifiedAt}.png`,
    bytes: 1_000,
    ...over
  };
}

describe("archiveFileName", () => {
  it("shares the saved-capture name shape and appends the kind", () => {
    const when = new Date(2026, 8, 24, 19, 26, 5);
    expect(archiveFileName(when, "area")).toBe("Marshal 2026-09-24 19.26.05 area.png");
    expect(archiveFileName(when, "fullscreen")).toBe("Marshal 2026-09-24 19.26.05 fullscreen.png");
  });

  it("omits the suffix when there is no kind", () => {
    expect(archiveFileName(new Date(2026, 0, 2, 3, 4, 5), "")).toBe("Marshal 2026-01-02 03.04.05.png");
  });
});

describe("planPrune", () => {
  it("keeps everything inside both caps", () => {
    const entries = [entry({ modifiedAt: 3 }), entry({ modifiedAt: 1 }), entry({ modifiedAt: 2 })];
    expect(planPrune(entries, { maxEntries: 10, maxBytes: 10_000 })).toEqual([]);
  });

  it("drops the oldest past the count cap, whatever order it is handed", () => {
    const entries = [entry({ modifiedAt: 1 }), entry({ modifiedAt: 3 }), entry({ modifiedAt: 2 })];
    expect(planPrune(entries, { maxEntries: 2, maxBytes: 10_000 })).toEqual(["/tmp/1.png"]);
  });

  it("drops the oldest past the byte budget", () => {
    const entries = [
      entry({ modifiedAt: 3, bytes: 600 }),
      entry({ modifiedAt: 2, bytes: 600 }),
      entry({ modifiedAt: 1, bytes: 600 })
    ];
    expect(planPrune(entries, { maxEntries: 10, maxBytes: 1_000 })).toEqual([
      "/tmp/2.png",
      "/tmp/1.png"
    ]);
  });

  it("keeps the newest capture even when it alone blows the budget", () => {
    // Deleting the screenshot the user just took, to satisfy a quota, would be
    // a worse outcome than briefly exceeding it.
    const entries = [entry({ modifiedAt: 2, bytes: 5_000 }), entry({ modifiedAt: 1, bytes: 10 })];
    expect(planPrune(entries, { maxEntries: 10, maxBytes: 1_000 })).toEqual(["/tmp/1.png"]);
  });

  it("defaults to the shipped caps", () => {
    expect(ARCHIVE_MAX_ENTRIES).toBe(300);
    expect(ARCHIVE_MAX_BYTES).toBe(600 * 1024 * 1024);
    expect(planPrune([entry({ modifiedAt: 1 })])).toEqual([]);
  });
});

describe("CaptureArchive", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-archive-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records a capture and lists it back", () => {
    const archive = new CaptureArchive(dir);
    const written = archive.record(PNG_BASE64, "area", new Date(2026, 8, 24, 19, 26, 5));

    expect(written).toBe(path.join(dir, "Marshal 2026-09-24 19.26.05 area.png"));
    const listed = archive.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("Marshal 2026-09-24 19.26.05 area.png");
    expect(listed[0].bytes).toBeGreaterThan(0);
  });

  it("creates the folder on first use", () => {
    const nested = path.join(dir, "not", "there", "yet");
    expect(new CaptureArchive(nested).record(PNG_BASE64, "area")).not.toBeNull();
    expect(new CaptureArchive(nested).list()).toHaveLength(1);
  });

  it("reads an absent folder as empty rather than throwing", () => {
    expect(new CaptureArchive(path.join(dir, "missing")).list()).toEqual([]);
  });

  it("does not let two captures in the same second overwrite each other", () => {
    const archive = new CaptureArchive(dir);
    const when = new Date(2026, 8, 24, 19, 26, 5);
    const first = archive.record(PNG_BASE64, "area", when);
    const second = archive.record(PNG_BASE64, "area", when);

    expect(second).not.toBe(first);
    expect(path.basename(second!)).toBe("Marshal 2026-09-24 19.26.05 area (2).png");
    expect(archive.list()).toHaveLength(2);
  });

  it("prunes past the count cap on write", () => {
    // Seeding runs through a cap-free instance so the pruner cannot fire
    // before every mtime is set, and the mtimes are minutes back from *now*
    // rather than a fixed calendar date: the final write below carries a real
    // mtime and has to be the newest entry on any machine clock. A fixed date
    // is in the past in one timezone and the future in another, and on a UTC
    // CI runner it made the pruner discard the file that had just been
    // written.
    const seeding = new CaptureArchive(dir, { maxEntries: 99 });
    const seeded: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const written = seeding.record(PNG_BASE64, "area", new Date(2026, 8, 24, 19, 26, i))!;
      const when = new Date(Date.now() - (10 - i) * 60_000);
      fs.utimesSync(written, when, when);
      seeded.push(path.basename(written));
    }
    expect(seeding.list()).toHaveLength(4);

    const capped = new CaptureArchive(dir, { maxEntries: 2 });
    const fresh = capped.record(PNG_BASE64, "area", new Date(2026, 8, 24, 19, 27, 0))!;

    const names = capped.list().map((e) => e.name);
    expect(names).toHaveLength(2);
    expect(names).toContain(path.basename(fresh));
    expect(names).toContain(seeded[3]);
    expect(names).not.toContain(seeded[0]);
  });

  it("replaces an entry in place so annotating leaves one history row", () => {
    const archive = new CaptureArchive(dir);
    const written = archive.record(PNG_BASE64, "area")!;
    const before = fs.statSync(written).size;

    expect(archive.replace(written, `${PNG_BASE64}`)).toBe(true);
    expect(archive.list()).toHaveLength(1);
    expect(fs.statSync(written).size).toBe(before);
  });

  it("refuses to replace a path outside the archive", () => {
    const archive = new CaptureArchive(path.join(dir, "archive"));
    const foreign = path.join(dir, "user-saved.png");
    fs.writeFileSync(foreign, "not a png");

    expect(archive.replace(foreign, PNG_BASE64)).toBe(false);
    expect(fs.readFileSync(foreign, "utf8")).toBe("not a png");
  });

  it("refuses to replace an entry that has already been pruned", () => {
    const archive = new CaptureArchive(dir);
    const written = archive.record(PNG_BASE64, "area")!;
    fs.unlinkSync(written);
    expect(archive.replace(written, PNG_BASE64)).toBe(false);
  });

  it("only claims paths inside its own folder", () => {
    const archive = new CaptureArchive(path.join(dir, "archive"));
    expect(archive.contains(path.join(dir, "archive", "x.png"))).toBe(true);
    expect(archive.contains(path.join(dir, "archive-elsewhere", "x.png"))).toBe(false);
    expect(archive.contains(path.join(dir, "x.png"))).toBe(false);
  });
});
