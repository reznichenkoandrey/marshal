// tests/mic-discover.test.ts
// Unit tests for mic-discover.ts — JSON parser + spawn wrapper. The actual
// Core Audio HAL probe is integration-tested live by mic-list.swift, not
// here; we only assert the contract between the helper and the JSON it
// receives so renderer-side code can rely on the shape.

import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";

import {
  listMicrophones,
  parseMicList,
  type Microphone
} from "../desktop/dictation/mic-discover.ts";

const tmpRoot = path.join(os.tmpdir(), "marshal-mic-discover-tests");

async function writeStubBin(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(`${tmpRoot}-`);
  const target = path.join(dir, name);
  await writeFile(target, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(target, 0o755);
  return target;
}

const BUILTIN: Microphone = {
  id: "BuiltInMicrophoneDevice",
  name: "MacBook Pro Microphone",
  isDefault: true,
  manufacturer: "Apple Inc.",
  transportType: "BuiltIn"
};

describe("parseMicList", () => {
  it("parses a JSON array of valid devices", () => {
    const stdout = JSON.stringify([BUILTIN]);
    const result = parseMicList(stdout);
    expect(result).toEqual([BUILTIN]);
  });

  it("returns empty list on empty stdout", () => {
    expect(parseMicList("")).toEqual([]);
    expect(parseMicList("   \n")).toEqual([]);
  });

  it("returns empty list on malformed JSON", () => {
    expect(parseMicList("not json")).toEqual([]);
    expect(parseMicList("[{ id:")).toEqual([]);
  });

  it("returns empty list when top-level is not an array", () => {
    expect(parseMicList('{"id":"X"}')).toEqual([]);
    expect(parseMicList('"string"')).toEqual([]);
    expect(parseMicList("null")).toEqual([]);
  });

  it("skips entries without a valid id", () => {
    const stdout = JSON.stringify([
      { id: "", name: "Missing UID" },
      { id: "valid-uid", name: "OK", isDefault: true, manufacturer: "", transportType: "USB" }
    ]);
    const result = parseMicList(stdout);
    expect(result.map((m) => m.id)).toEqual(["valid-uid"]);
  });

  it("coerces missing string fields to empty strings", () => {
    const stdout = JSON.stringify([{ id: "x", name: "Just name" }]);
    const result = parseMicList(stdout);
    expect(result[0]).toEqual({
      id: "x",
      name: "Just name",
      isDefault: false,
      manufacturer: "",
      transportType: ""
    });
  });

  it("treats non-true isDefault values as false", () => {
    const stdout = JSON.stringify([
      { id: "a", name: "A", isDefault: "yes" },
      { id: "b", name: "B", isDefault: 1 },
      { id: "c", name: "C", isDefault: true }
    ]);
    const result = parseMicList(stdout);
    expect(result.find((m) => m.id === "a")?.isDefault).toBe(false);
    expect(result.find((m) => m.id === "b")?.isDefault).toBe(false);
    expect(result.find((m) => m.id === "c")?.isDefault).toBe(true);
  });

  it("falls back to the id for the display name when name is missing/empty", () => {
    const stdout = JSON.stringify([{ id: "weird-uid", name: "" }]);
    const result = parseMicList(stdout);
    expect(result[0].name).toBe("weird-uid");
  });
});

describe("listMicrophones", () => {
  it("returns parsed devices when the helper exits cleanly", async () => {
    const bin = await writeStubBin(
      "mic-list-ok",
      `echo '${JSON.stringify([BUILTIN])}'`
    );
    try {
      const result = await listMicrophones({ binPath: bin });
      expect(result).toEqual([BUILTIN]);
    } finally {
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  it("resolves to empty list if the binary is missing", async () => {
    const result = await listMicrophones({
      binPath: "/nonexistent/path/mic-list-does-not-exist"
    });
    expect(result).toEqual([]);
  });

  it("times out gracefully on a hung helper", async () => {
    const bin = await writeStubBin("mic-list-hang", "sleep 5");
    try {
      const start = Date.now();
      const result = await listMicrophones({ binPath: bin, timeoutMs: 100 });
      const elapsed = Date.now() - start;
      expect(result).toEqual([]);
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  it("returns empty on malformed helper output", async () => {
    const bin = await writeStubBin("mic-list-garbage", 'echo "not json at all"');
    try {
      const result = await listMicrophones({ binPath: bin });
      expect(result).toEqual([]);
    } finally {
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });
});
