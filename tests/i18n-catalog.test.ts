import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../desktop/i18n/en.ts";
import { uk } from "../desktop/i18n/uk.ts";
import { formatMessage, translate } from "../desktop/i18n/catalog.ts";

const RENDERER = path.join(import.meta.dirname, "..", "desktop", "renderer");
const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
const tags = (value: string): string[] => [...value.matchAll(/<\/?([a-z]+)/gu)].map((match) => match[1]).sort();
const files = (extension: string): string[] => readdirSync(RENDERER).filter((name) => name.endsWith(extension));
const read = (name: string): string => readFileSync(path.join(RENDERER, name), "utf8");

describe("UI string catalogs (#330)", () => {
  it("have the same keys in English and Ukrainian", () => {
    expect(Object.keys(uk).sort()).toEqual(Object.keys(en).sort());
  });

  it("keep every placeholder and markup tag in both languages", () => {
    for (const [key, english] of Object.entries(en)) {
      const ukrainian = uk[key as keyof typeof en];
      expect(ukrainian.trim(), key).not.toBe("");
      expect(placeholders(ukrainian), key).toEqual(placeholders(english));
      expect(tags(ukrainian), key).toEqual(tags(english));
    }
  });

  it("fill placeholders and fall back to English", () => {
    expect(formatMessage("{a} of {b}, {c}", { a: 1, b: "two" })).toBe("1 of two, {c}");
    expect(translate("uk", "home.recent")).toBe("Останнє");
  });

  it("know every key the renderer markup and scripts ask for", () => {
    const known = new Set(Object.keys(en));
    const missing: string[] = [];
    for (const name of files(".html")) {
      const html = read(name);
      const used = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/gu)].map((match) => match[1]);
      if (used.length) expect(html, `${name} loads i18n.js`).toContain('src="./i18n.js"');
      missing.push(...used.filter((key) => !known.has(key)).map((key) => `${name}: ${key}`));
    }
    for (const name of files(".js")) {
      const used = [...read(name).matchAll(/\bt\("([\w.]+)"/gu)].map((match) => match[1]);
      missing.push(...used.filter((key) => !known.has(key)).map((key) => `${name}: ${key}`));
    }
    expect(missing).toEqual([]);
  });
});
