import { describe, expect, it } from "vitest";

import { findAppBundleAncestor, planSwap } from "../desktop/updater/swap-planner.ts";

describe("findAppBundleAncestor", () => {
  it("finds the .app bundle in a normal install layout", () => {
    expect(findAppBundleAncestor("/Applications/Marshal.app/Contents/MacOS/Marshal")).toBe(
      "/Applications/Marshal.app"
    );
  });

  it("returns the deepest .app when nested", () => {
    expect(
      findAppBundleAncestor("/Volumes/Marshal/Marshal.app/Contents/MacOS/Marshal")
    ).toBe("/Volumes/Marshal/Marshal.app");
  });

  it("returns null for a plain node script", () => {
    expect(findAppBundleAncestor("/usr/local/bin/node")).toBeNull();
  });
});

describe("planSwap", () => {
  it("approves a normal /Applications install", () => {
    const decision = planSwap({
      execPath: "/Applications/Marshal.app/Contents/MacOS/Marshal"
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan).toEqual({
      currentAppPath: "/Applications/Marshal.app",
      installDir: "/Applications",
      appName: "Marshal.app"
    });
  });

  it("approves an install in a user directory", () => {
    const decision = planSwap({
      execPath: "/Users/alex/Downloads/Marshal.app/Contents/MacOS/Marshal"
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.installDir).toBe("/Users/alex/Downloads");
  });

  it("refuses dev-mode Electron (Electron.app ancestor)", () => {
    const decision = planSwap({
      execPath:
        "/Users/me/htdocs/marshal/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusal.reason).toBe("not-packaged");
  });

  it("refuses a DMG-mounted bundle on /Volumes/", () => {
    const decision = planSwap({
      execPath: "/Volumes/Marshal 0.1.4/Marshal.app/Contents/MacOS/Marshal"
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusal.reason).toBe("read-only-volume");
  });

  it("refuses when execPath is not inside a .app at all", () => {
    const decision = planSwap({ execPath: "/usr/local/bin/some-binary" });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusal.reason).toBe("not-packaged");
  });

  it("allows bypassing the Electron check for test fixtures", () => {
    const decision = planSwap({
      execPath: "/Users/me/Electron.app/Contents/MacOS/Electron",
      bypassDevCheck: true
    });
    expect(decision.ok).toBe(true);
  });
});
