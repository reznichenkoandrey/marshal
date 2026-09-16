// tests/display-source.test.ts
//
// Covers the source-matching half of #136. The other half — asking for the
// display under the pointer rather than the primary one — needs a real screen
// and lives in the e2e harness.

import { describe, expect, it } from "vitest";

import { pickSourceForDisplay, type ScreenSourceLike } from "../desktop/capture/display-source.ts";

const laptop: ScreenSourceLike = { display_id: "1", name: "Built-in Retina Display" };
const external: ScreenSourceLike = { display_id: "2", name: "LG UltraFine" };
const third: ScreenSourceLike = { display_id: "69733382", name: "DELL U2720Q" };

describe("pickSourceForDisplay", () => {
  it("finds the source for the requested display", () => {
    expect(pickSourceForDisplay([laptop, external], 2)).toBe(external);
    expect(pickSourceForDisplay([laptop, external], 1)).toBe(laptop);
  });

  it("does not assume the first source is the one asked for", () => {
    // The regression this guards: taking sources[0] captured the laptop screen
    // while the user was working on the external monitor.
    const sources = [laptop, external, third];
    expect(pickSourceForDisplay(sources, 69733382)).toBe(third);
    expect(pickSourceForDisplay(sources, 69733382)).not.toBe(sources[0]);
  });

  it("accepts a numeric display id, which is how Electron reports Display.id", () => {
    // desktopCapturer gives display_id as a string; screen.Display.id is a
    // number. Matching has to bridge the two.
    expect(pickSourceForDisplay([external], 2)).toBe(external);
    expect(pickSourceForDisplay([external], "2")).toBe(external);
  });

  it("returns null when no source matches, rather than a wrong screen", () => {
    expect(pickSourceForDisplay([laptop, external], 99)).toBeNull();
  });

  it("returns null for an empty source list", () => {
    expect(pickSourceForDisplay([], 1)).toBeNull();
  });

  it("matches exactly, never by prefix", () => {
    // "1" must not match "12" — a substring match here would capture the
    // wrong monitor on a machine whose display ids share a prefix.
    const ambiguous: ScreenSourceLike[] = [
      { display_id: "12", name: "second" },
      { display_id: "1", name: "first" }
    ];
    expect(pickSourceForDisplay(ambiguous, 1)?.name).toBe("first");
    expect(pickSourceForDisplay(ambiguous, 12)?.name).toBe("second");
  });

  it("returns the first match when a machine reports duplicate ids", () => {
    const duplicate: ScreenSourceLike[] = [
      { display_id: "3", name: "one" },
      { display_id: "3", name: "two" }
    ];
    expect(pickSourceForDisplay(duplicate, 3)?.name).toBe("one");
  });
});
