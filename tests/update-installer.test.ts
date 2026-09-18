import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

import {
  UpdateInstaller,
  buildSwapScript,
  sha512Base64
} from "../desktop/updater/update-installer.ts";

describe("sha512Base64", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "marshal-sha-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("matches Node's reference digest for a known file", async () => {
    const filePath = path.join(tmp, "data.bin");
    const payload = Buffer.from("marshal-updater-test-payload");
    await fs.writeFile(filePath, payload);

    const expected = createHash("sha512").update(payload).digest("base64");
    const actual = await sha512Base64(filePath);

    expect(actual).toBe(expected);
  });

  it("handles empty files", async () => {
    const filePath = path.join(tmp, "empty.bin");
    await fs.writeFile(filePath, "");
    const expected = createHash("sha512").update("").digest("base64");
    const actual = await sha512Base64(filePath);
    expect(actual).toBe(expected);
  });
});

describe("buildSwapScript", () => {
  it("emits a bash script with shebang and uses all six positional args", () => {
    const script = buildSwapScript();
    expect(script.startsWith("#!/bin/bash")).toBe(true);
    // All five expected positional parameters must appear at least once.
    expect(script).toMatch(/PARENT_PID="\$\{1:-\}"/);
    expect(script).toMatch(/STAGING_APP="\$\{2:-\}"/);
    expect(script).toMatch(/INSTALL_DIR="\$\{3:-\}"/);
    expect(script).toMatch(/APP_NAME="\$\{4:-\}"/);
    expect(script).toMatch(/LOG="\$\{5:-/);
  });

  it("two-phase swap pattern: backup, install new, cleanup on success", () => {
    const script = buildSwapScript();
    // The order of mv operations is the safety contract — verify it's there.
    expect(script.indexOf('mv "$INSTALL_APP" "$BACKUP"')).toBeGreaterThan(0);
    expect(script.indexOf('mv "$STAGING_APP" "$INSTALL_APP"')).toBeGreaterThan(
      script.indexOf('mv "$INSTALL_APP" "$BACKUP"')
    );
    expect(script).toContain('rm -rf "$BACKUP"');
  });

  it("rolls back the backup if mv-in fails", () => {
    const script = buildSwapScript();
    expect(script).toMatch(/rolling back/);
    expect(script).toMatch(/mv "\$BACKUP" "\$INSTALL_APP"/);
  });

  it("opens the bundle at the end", () => {
    const script = buildSwapScript();
    expect(script).toContain('/usr/bin/open "$INSTALL_APP"');
  });

  it("strips com.apple.quarantine before swapping", () => {
    const script = buildSwapScript();
    expect(script).toContain("xattr -dr com.apple.quarantine");
  });
});

// #170: the pid is interpolated into a shell script, where a bad value is not
// an error but a skipped wait loop — and the bundle then gets replaced under a
// running app. Both ends are guarded: the constructor, so it fails before the
// 131 MB download, and the script, so it fails even if something bypasses it.
describe("parentPid validation", () => {
  it("rejects values that would silently skip the wait loop", () => {
    for (const pid of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new UpdateInstaller({ parentPid: pid })).toThrow(/positive integer parentPid/u);
    }
  });

  it("accepts a real pid and defaults to this process", () => {
    expect(() => new UpdateInstaller({ parentPid: 1234 })).not.toThrow();
    expect(() => new UpdateInstaller()).not.toThrow();
  });
});

describe("swap script refuses a bad PARENT_PID", () => {
  let dir = "";

  beforeEach(() => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "marshal-swap-"));
    fsSync.mkdirSync(path.join(dir, "installdir", "Marshal.app"), { recursive: true });
    fsSync.writeFileSync(path.join(dir, "installdir", "Marshal.app", "VERSION"), "OLD");
    fsSync.mkdirSync(path.join(dir, "staging", "Marshal.app"), { recursive: true });
    fsSync.writeFileSync(path.join(dir, "staging", "Marshal.app", "VERSION"), "NEW");
    // The generated script ends by launching the installed bundle; that must
    // not happen in a test run.
    const script = buildSwapScript().replace('/usr/bin/open "$INSTALL_APP"', "true");
    fsSync.writeFileSync(path.join(dir, "swap.sh"), script, { mode: 0o755 });
  });

  afterEach(() => {
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  const run = (pid: string): number => {
    const result = spawnSync(
      "bash",
      [
        path.join(dir, "swap.sh"),
        pid,
        path.join(dir, "staging", "Marshal.app"),
        path.join(dir, "installdir"),
        "Marshal.app",
        path.join(dir, "swap.log")
      ],
      { encoding: "utf8" }
    );
    return result.status ?? -1;
  };

  const installedVersion = (): string =>
    fsSync.readFileSync(path.join(dir, "installdir", "Marshal.app", "VERSION"), "utf8");

  it("exits 5 and leaves the installed bundle untouched", () => {
    for (const pid of ["NaN", "", "abc", "-1", "12x"]) {
      expect(run(pid)).toBe(5);
      expect(installedVersion()).toBe("OLD");
    }
  });

  it("says why, in the log, instead of failing silently", () => {
    run("NaN");
    expect(fsSync.readFileSync(path.join(dir, "swap.log"), "utf8")).toMatch(/PARENT_PID is not a positive integer/u);
  });

  it("still swaps for a valid pid — the guard is not just refusing everything", () => {
    // pid 1 (launchd) is alive, so the wait loop would spin; a pid that is
    // certainly dead lets the script proceed immediately.
    expect(run("2147483647")).toBe(0);
    expect(installedVersion()).toBe("NEW");
  });
});

describe("UpdateInstaller.prepare — happy path", () => {
  // A self-contained pipeline test that drives the installer with an in-memory
  // ZIP payload and stubbed ditto-replacement to validate the end-to-end flow
  // without touching `/usr/bin/ditto`.
  let scratch: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "marshal-installer-test-"));
  });

  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it("downloads, verifies sha, stages a script and produces a plan", async () => {
    const zipPayload = Buffer.from("not-a-real-zip-but-shaped-the-same");
    const sha = createHash("sha512").update(zipPayload).digest("base64");

    // Stub fetch to return the payload.
    const fetchImpl = (async () =>
      new Response(zipPayload, {
        status: 200,
        headers: { "content-length": String(zipPayload.length) }
      })) as unknown as typeof fetch;

    // Stub spawn so `ditto` is replaced by a no-op that creates the .app dir.
    const fakeSpawn = ((cmd: string, args: string[]) => {
      const child = {
        stdout: null,
        stderr: { on: () => undefined },
        on: (event: string, cb: (code: number) => void) => {
          if (event === "close") {
            if (cmd === "/usr/bin/ditto") {
              // ditto -x -k <zip> <dest>
              const dest = args[args.length - 1];
              void (async () => {
                await fs.mkdir(path.join(dest, "Marshal.app"), { recursive: true });
                cb(0);
              })();
            } else {
              cb(0);
            }
          }
          return child;
        },
        unref: () => undefined
      };
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const installer = new UpdateInstaller({
      scratchRoot: scratch,
      fetchImpl,
      spawnImpl: fakeSpawn,
      parentPid: 99999
    });

    const phases: string[] = [];
    installer.onProgress((p) => phases.push(p.phase));

    const prepared = await installer.prepare(
      { zipUrl: "https://example/zip", sha512: sha, size: zipPayload.length, version: "0.1.5" },
      {
        currentAppPath: "/Applications/Marshal.app",
        installDir: "/Applications",
        appName: "Marshal.app"
      }
    );

    expect(prepared.plan.appName).toBe("Marshal.app");
    expect(await fs.stat(prepared.newAppPath).then((s) => s.isDirectory())).toBe(true);
    expect(await fs.readFile(prepared.scriptPath, "utf8")).toContain("post-quit-installer");
    expect(phases).toContain("downloading");
    expect(phases).toContain("verifying");
    expect(phases).toContain("extracting");
    expect(phases.at(-1)).toBe("staging");
  });

  it("aborts and emits an error phase when the SHA does not match", async () => {
    const zipPayload = Buffer.from("payload");
    const fetchImpl = (async () =>
      new Response(zipPayload, {
        status: 200,
        headers: { "content-length": String(zipPayload.length) }
      })) as unknown as typeof fetch;

    // ditto is never reached but we still provide a stub.
    const fakeSpawn = ((..._args: unknown[]) => ({
      stdout: null,
      stderr: { on: () => undefined },
      on: (event: string, cb: (code: number) => void) => {
        if (event === "close") cb(0);
        return { unref: () => undefined };
      },
      unref: () => undefined
    })) as unknown as typeof import("node:child_process").spawn;

    const installer = new UpdateInstaller({
      scratchRoot: scratch,
      fetchImpl,
      spawnImpl: fakeSpawn,
      parentPid: 99999
    });

    const phases: string[] = [];
    installer.onProgress((p) => phases.push(p.phase));

    await expect(
      installer.prepare(
        { zipUrl: "https://example/zip", sha512: "wrong-sha", size: zipPayload.length, version: "0.1.5" },
        {
          currentAppPath: "/Applications/Marshal.app",
          installDir: "/Applications",
          appName: "Marshal.app"
        }
      )
    ).rejects.toThrow(/SHA-512 mismatch/);

    expect(phases.at(-1)).toBe("error");
  });
});

// #172: every successful update left its 131 MB archive in the temp dir
// forever — three runs measured 407 MB. The script frees what it can; the
// directory it runs from is swept by the next launch.
describe("staging cleanup after a successful swap", () => {
  let dir = "";

  beforeEach(() => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "marshal-clean-"));
    fsSync.mkdirSync(path.join(dir, "installdir"), { recursive: true });
    fsSync.mkdirSync(path.join(dir, "staging", "extracted", "Marshal.app"), { recursive: true });
    fsSync.writeFileSync(path.join(dir, "staging", "extracted", "Marshal.app", "VERSION"), "NEW");
    // Stand in for the 131 MB download.
    fsSync.writeFileSync(path.join(dir, "staging", "marshal.zip"), "x".repeat(4096));
    const script = buildSwapScript().replace('/usr/bin/open "$INSTALL_APP"', "true");
    fsSync.writeFileSync(path.join(dir, "staging", "swap.sh"), script, { mode: 0o755 });
  });

  afterEach(() => {
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  const run = (): number =>
    spawnSync(
      "bash",
      [
        path.join(dir, "staging", "swap.sh"),
        "2147483647",
        path.join(dir, "staging", "extracted", "Marshal.app"),
        path.join(dir, "installdir"),
        "Marshal.app",
        path.join(dir, "staging", "swap.log"),
        path.join(dir, "staging")
      ],
      { encoding: "utf8" }
    ).status ?? -1;

  it("deletes the downloaded archive and the emptied extract dir", () => {
    expect(run()).toBe(0);
    expect(fsSync.existsSync(path.join(dir, "installdir", "Marshal.app"))).toBe(true);
    expect(fsSync.existsSync(path.join(dir, "staging", "marshal.zip"))).toBe(false);
    expect(fsSync.existsSync(path.join(dir, "staging", "extracted"))).toBe(false);
  });

  it("keeps the script it is running from, and the log", () => {
    // Removing the directory here would pull the file out from under the bash
    // still reading it — the sweep at next launch handles the remainder.
    run();
    expect(fsSync.existsSync(path.join(dir, "staging", "swap.sh"))).toBe(true);
    expect(fsSync.readFileSync(path.join(dir, "staging", "swap.log"), "utf8"))
      .toMatch(/freed the downloaded archive/u);
  });

  it("does not clean up when the swap failed", () => {
    fsSync.chmodSync(path.join(dir, "installdir"), 0o555);
    try {
      expect(run()).toBe(2);
      expect(fsSync.existsSync(path.join(dir, "staging", "marshal.zip"))).toBe(true);
    } finally {
      fsSync.chmodSync(path.join(dir, "installdir"), 0o755);
    }
  });
});

describe("UpdateInstaller.sweepStale", () => {
  let root = "";

  beforeEach(() => {
    root = fsSync.mkdtempSync(path.join(os.tmpdir(), "marshal-sweep-"));
  });

  afterEach(() => {
    fsSync.rmSync(root, { recursive: true, force: true });
  });

  const stage = (name: string, ageMs: number): string => {
    const dir = path.join(root, name);
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(path.join(dir, "marshal.zip"), "payload");
    const when = new Date(Date.now() - ageMs);
    fsSync.utimesSync(dir, when, when);
    return dir;
  };

  it("removes directories older than the cutoff and keeps fresh ones", async () => {
    const old = stage("v0.2.5-aaa", 48 * 60 * 60 * 1000);
    const fresh = stage("v0.2.8-bbb", 60 * 1000);

    const removed = await new UpdateInstaller({ scratchRoot: root }).sweepStale();

    expect(removed).toBe(1);
    expect(fsSync.existsSync(old)).toBe(false);
    expect(fsSync.existsSync(fresh)).toBe(true);
  });

  it("honours an explicit max age", async () => {
    stage("v0.2.8-bbb", 5 * 60 * 1000);
    const removed = await new UpdateInstaller({ scratchRoot: root }).sweepStale(60 * 1000);
    expect(removed).toBe(1);
  });

  it("is a no-op when nothing was ever staged", async () => {
    const missing = path.join(root, "never-created");
    await expect(new UpdateInstaller({ scratchRoot: missing }).sweepStale()).resolves.toBe(0);
  });
});
