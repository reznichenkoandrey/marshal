import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EMPTY_CONTEXT,
  loadReferenceContext,
  ReferenceContextCache
} from "../desktop/captions/context-store.ts";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-captions-context-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadReferenceContext (#188)", () => {
  it("is empty for a missing or empty folder", async () => {
    expect(await loadReferenceContext(path.join(dir, "nope"))).toEqual(EMPTY_CONTEXT);
    expect(await loadReferenceContext(dir)).toEqual(EMPTY_CONTEXT);
  });

  it("concatenates text files under headers, smallest first, and ignores everything else", async () => {
    fs.writeFileSync(path.join(dir, "cv.md"), "# Andrii\nSenior developer, Magento and TypeScript.");
    fs.writeFileSync(path.join(dir, "stack.txt"), "Kafka, Redis.");
    fs.writeFileSync(path.join(dir, "photo.png"), "binary");
    fs.writeFileSync(path.join(dir, ".hidden.md"), "secret");
    fs.mkdirSync(path.join(dir, "notes.md"));
    const context = await loadReferenceContext(dir);
    expect(context.files.map((file) => file.name)).toEqual(["stack.txt", "cv.md"]);
    expect(context.text).toBe("### stack.txt\nKafka, Redis.\n\n### cv.md\n# Andrii\nSenior developer, Magento and TypeScript.");
    expect(context.truncated).toBe(0);
  });

  it("cuts the biggest file at the budget and lists the rest as omitted", async () => {
    fs.writeFileSync(path.join(dir, "small.md"), "x".repeat(100));
    fs.writeFileSync(path.join(dir, "big.md"), "y".repeat(1_000));
    fs.writeFileSync(path.join(dir, "huge.md"), "z".repeat(5_000));
    const context = await loadReferenceContext(dir, 700);
    expect(context.files.find((file) => file.name === "small.md")?.included).toBe(100);
    const big = context.files.find((file) => file.name === "big.md")!;
    expect(big.included).toBeGreaterThan(0);
    expect(big.included).toBeLessThan(1_000);
    expect(context.files.find((file) => file.name === "huge.md")?.included).toBe(0);
    expect(context.text).toContain("[… truncated]");
    expect(context.text).toContain("(omitted for length: huge.md)");
    expect(context.text.length).toBeLessThanOrEqual(700 + 60);
    expect(context.truncated).toBe(1_000 - big.included + 5_000);
  });
});

describe("ReferenceContextCache", () => {
  it("re-reads only when a file changes, appears or disappears", async () => {
    fs.writeFileSync(path.join(dir, "a.md"), "first");
    const cache = new ReferenceContextCache(dir);
    const first = await cache.get();
    expect(first.text).toContain("first");
    expect(await cache.get()).toBe(first);

    fs.writeFileSync(path.join(dir, "a.md"), "second version");
    const second = await cache.get();
    expect(second).not.toBe(first);
    expect(second.text).toContain("second version");

    fs.writeFileSync(path.join(dir, "b.txt"), "more");
    expect((await cache.get()).files).toHaveLength(2);

    fs.unlinkSync(path.join(dir, "a.md"));
    expect((await cache.get()).files.map((file) => file.name)).toEqual(["b.txt"]);
  });
});
