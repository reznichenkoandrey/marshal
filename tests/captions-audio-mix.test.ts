import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The mixer lives inside the Swift helper; its --self-test runs the checks on
// synthetic samples (#212). Needs `npm run build`, so it is skipped elsewhere.
const bin = path.resolve(import.meta.dirname, "..", "dist", "desktop", "captions", "system-audio-tap");

describe.skipIf(!fs.existsSync(bin))("system-audio-tap mixer", () => {
  it("passes quiet sums through and soft-limits overlap instead of hard clipping", () => {
    expect(() => execFileSync(bin, ["--self-test"], { stdio: "pipe" })).not.toThrow();
  });
});
