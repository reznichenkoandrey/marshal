import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createCallPresence, isOnCall, parseMicUsers } from "../desktop/presence/call-presence.ts";

async function stubHelper(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "marshal-call-presence-"));
  const bin = path.join(dir, "mic-users");
  await writeFile(bin, `#!/bin/sh\n${body}\n`);
  await chmod(bin, 0o755);
  return bin;
}

describe("parseMicUsers", () => {
  it("reads pid, parent pid and bundle id, which bare executables lack", () => {
    expect(parseMicUsers("69646 69405 com.google.Chrome.helper\n11153 11149 \n\ngarbage\n")).toEqual([
      { pid: 69646, ppid: 69405, bundleId: "com.google.Chrome.helper" },
      { pid: 11153, ppid: 11149, bundleId: "" }
    ]);
  });
});

describe("isOnCall", () => {
  it("ignores Marshal itself and its direct children", () => {
    expect(isOnCall([{ pid: 100, ppid: 1, bundleId: "com.marshal.desktop" }], 100)).toBe(false);
    expect(isOnCall([{ pid: 101, ppid: 100, bundleId: "com.marshal.desktop.helper" }], 100)).toBe(false);
  });

  it("is a call when any other process captures input", () => {
    expect(isOnCall([{ pid: 69646, ppid: 69405, bundleId: "com.google.Chrome.helper" }], 100)).toBe(true);
  });

  it("is not a call when nobody captures input", () => {
    expect(isOnCall([], 100)).toBe(false);
  });
});

describe("createCallPresence", () => {
  it("reports a call from the helper output", async () => {
    const bin = await stubHelper('echo "500 1 us.zoom.xos"');
    expect(await createCallPresence({ binPath: bin, ownPid: 100 })()).toBe(true);
  });

  it("treats a missing or failing helper as no call, so speech still works", async () => {
    expect(await createCallPresence({ binPath: "/nonexistent/mic-users", ownPid: 100 })()).toBe(false);
    const failing = await stubHelper('echo "500 1 us.zoom.xos"; exit 3');
    expect(await createCallPresence({ binPath: failing, ownPid: 100 })()).toBe(false);
  });

  it("probes once per burst, then again after the cache expires", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "marshal-call-presence-count-"));
    const counter = path.join(dir, "runs");
    const bin = await stubHelper(`echo x >> "${counter}"`);
    let clock = 0;
    const probe = createCallPresence({ binPath: bin, ownPid: 100, now: () => clock });
    await probe();
    await probe();
    clock = 5_000;
    await probe();
    expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(2);
  });
});
