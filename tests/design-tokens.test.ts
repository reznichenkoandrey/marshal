import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

const tokens = read("desktop/renderer/design-tokens.css");
const themeJs = read("desktop/renderer/theme.js");

function listFrom(name: string): string[] {
  const match = themeJs.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`));
  if (!match) throw new Error(`${name} not found in theme.js`);
  return [...match[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
}

function seedsIn(selector: string): string[] {
  const start = tokens.indexOf(`${selector} {`);
  if (start < 0) return [];
  const body = tokens.slice(start, tokens.indexOf("}", start));
  return [...body.matchAll(/(--seed-[a-z0-9-]+):/g)].map((m) => m[1]).sort();
}

describe("design tokens (#283)", () => {
  it("chrome extension mirror is identical", () => {
    expect(read("chrome-extension/src/sidepanel/design-tokens.css")).toBe(tokens);
  });

  const defaultSeeds = (() => {
    const start = tokens.indexOf("/* ── Look: HUD (default)");
    const body = tokens.slice(start, tokens.indexOf("}", start));
    return [...body.matchAll(/(--seed-[a-z0-9-]+):/g)].map((m) => m[1]).sort();
  })();

  it("every non-default look sets the full seed set, so nothing leaks from HUD", () => {
    for (const look of listFrom("LOOKS").filter((l) => l !== "hud")) {
      expect(seedsIn(`:root[data-look="${look}"]`), look).toEqual(defaultSeeds);
    }
  });

  it("every HUD palette has a rule, except the default blue", () => {
    for (const palette of listFrom("PALETTES").filter((p) => p !== "blue")) {
      expect(seedsIn(`:root[data-look="hud"][data-palette="${palette}"]`).length, palette).toBeGreaterThan(0);
    }
  });

  it("every look has a light and a dark value for each color seed", () => {
    const seeds = [...tokens.matchAll(/--seed-[a-z0-9-]+: (#[^;]+|light-dark\([^;]+\));/g)];
    for (const [line, value] of seeds) {
      if (value.startsWith("#")) continue; // mode-independent on purpose (shadow base)
      expect(value, line).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
    }
  });
});
