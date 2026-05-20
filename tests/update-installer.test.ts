import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  it("emits a bash script with shebang and uses all five positional args", () => {
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
