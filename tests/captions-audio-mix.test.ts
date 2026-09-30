import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The mixer lives inside the Swift helper; its --self-test runs the checks on
// synthetic samples (#212). Needs a helper built from the current source: a
// stale one ignores --self-test and starts a real capture.
const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "dist", "desktop", "captions", "system-audio-tap");
const src = path.join(root, "desktop", "captions", "swift", "system-audio-tap.swift");
const built = fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs;

describe.skipIf(!built)("system-audio-tap mixer", () => {
  it("passes quiet sums through and soft-limits overlap instead of hard clipping", () => {
    expect(() => execFileSync(bin, ["--self-test"], { stdio: "pipe", timeout: 5_000 })).not.toThrow();
  });
});
