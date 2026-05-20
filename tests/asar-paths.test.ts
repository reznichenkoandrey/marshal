import path from "node:path";
import { describe, expect, it } from "vitest";

import { asarUnpacked } from "../desktop/utils/asar-paths.ts";

describe("asarUnpacked", () => {
  it("rewrites paths inside app.asar to app.asar.unpacked", () => {
    expect(
      asarUnpacked("/Applications/Marshal.app/Contents/Resources/app.asar/dist/desktop/dictation")
    ).toBe(
      "/Applications/Marshal.app/Contents/Resources/app.asar.unpacked/dist/desktop/dictation"
    );
  });

  it("leaves dev paths untouched", () => {
    const dev = "/Users/me/htdocs/marshal/dist/desktop/dictation";
    expect(asarUnpacked(dev)).toBe(dev);
  });

  it("only rewrites the app.asar segment (not lookalikes)", () => {
    // A dir literally named "app.asar.unpacked" — we must not double-rewrite.
    const already =
      "/Applications/Marshal.app/Contents/Resources/app.asar.unpacked/dist";
    expect(asarUnpacked(already)).toBe(already);
  });

  it("is a no-op for paths without the asar segment", () => {
    expect(asarUnpacked("/tmp/foo/bar")).toBe("/tmp/foo/bar");
    expect(asarUnpacked("")).toBe("");
  });

  it("uses path.sep so the rewrite works on Windows-shaped paths too", () => {
    // Synthesize a fake Windows path. asarUnpacked uses path.sep, which on
    // posix is "/" — this still exercises the include() guard and ensures we
    // don't accidentally match across separators.
    const sep = path.sep;
    const input = `C:${sep}Apps${sep}Marshal${sep}resources${sep}app.asar${sep}dist`;
    const expected = `C:${sep}Apps${sep}Marshal${sep}resources${sep}app.asar.unpacked${sep}dist`;
    expect(asarUnpacked(input)).toBe(expected);
  });
});
