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
    expect(parseMicUsers("69646\t69405\tGoogle Chrome Helper\tcom.google.Chrome.helper\n11153\t11149\tffmpeg\t\n\ngarbage\n")).toEqual([
      { pid: 69646, ppid: 69405, name: "Google Chrome Helper", bundleId: "com.google.Chrome.helper" },
      { pid: 11153, ppid: 11149, name: "ffmpeg", bundleId: "" }
    ]);
  });
});

describe("isOnCall", () => {
  it("ignores Marshal itself and its direct children", () => {
    expect(isOnCall([{ pid: 100, ppid: 1, name: "Marshal", bundleId: "com.marshal.desktop" }], 100)).toBe(false);
    expect(isOnCall([{ pid: 101, ppid: 100, name: "Marshal Helper", bundleId: "com.marshal.desktop.helper" }], 100)).toBe(false);
  });

  it("is a call when any other process captures input", () => {
    expect(isOnCall([{ pid: 69646, ppid: 69405, name: "Google Chrome Helper", bundleId: "com.google.Chrome.helper" }], 100)).toBe(true);
  });

  it("ignores Siri, Voice Control and dictation, which hold the mic all the time", () => {
    expect(isOnCall([{ pid: 751, ppid: 1, name: "corespeechd", bundleId: "com.apple.CoreSpeech" }], 100)).toBe(false);
    expect(isOnCall([{ pid: 752, ppid: 1, name: "speechrecognitiond", bundleId: "" }], 100)).toBe(false);
  });

  it("is not a call when nobody captures input", () => {
    expect(isOnCall([], 100)).toBe(false);
  });
});

describe("createCallPresence", () => {
  it("reports a call from the helper output", async () => {
    const bin = await stubHelper('printf "500\\t1\\tzoom.us\\tus.zoom.xos\\n"');
    expect(await createCallPresence({ binPath: bin, ownPid: 100 })()).toBe(true);
  });

  it("treats a missing or failing helper as no call, so speech still works", async () => {
    expect(await createCallPresence({ binPath: "/nonexistent/mic-users", ownPid: 100 })()).toBe(false);
    const failing = await stubHelper('printf "500\\t1\\tzoom.us\\tus.zoom.xos\\n"; exit 3');
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
