import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  clampWindowState,
  findOnPath,
  hubUrl,
  isPrivateMode,
  parsePort,
  pickProfile,
  readProfiles,
  SmartHubService,
  type HubProfile
} from "../desktop/smart-tools/hub.ts";

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-hub-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("hub credentials (#416)", () => {
  it("accepts only a plausible port", () => {
    expect(parsePort("45123\n")).toBe(45123);
    expect(parsePort(" 80 ")).toBe(80);
    expect(parsePort("0")).toBeNull();
    expect(parsePort("70000")).toBeNull();
    expect(parsePort("")).toBeNull();
    expect(parsePort("not-a-port")).toBeNull();
  });

  it("keeps the hub on loopback", () => {
    expect(hubUrl(45123)).toBe("http://127.0.0.1:45123");
  });

  it("treats anything wider than 0600 as not private", () => {
    expect(isPrivateMode(0o100600)).toBe(true);
    expect(isPrivateMode(0o100640)).toBe(false);
    expect(isPrivateMode(0o100604)).toBe(false);
    expect(isPrivateMode(0o100666)).toBe(false);
  });

  it("reads the port and token the server wrote", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "port"), "45123\n", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "token"), "s3cret\n", { mode: 0o600 });
    const service = new SmartHubService({ dir, pathEnv: "" });
    expect(service.credentials()).toEqual({ port: 45123, token: "s3cret" });
  });

  it("refuses a token any process on the Mac could read", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "port"), "45123", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "token"), "s3cret", { mode: 0o644 });
    expect(new SmartHubService({ dir, pathEnv: "" }).credentials()).toBeNull();
  });

  it("reports no credentials when the hub never ran", () => {
    expect(new SmartHubService({ dir: tempDir(), pathEnv: "" }).credentials()).toBeNull();
  });
});

describe("hub binary lookup (#416)", () => {
  it("walks PATH in order and only takes executables", () => {
    const first = tempDir();
    const second = tempDir();
    fs.writeFileSync(path.join(first, "smart-hub"), "", { mode: 0o644 });
    fs.writeFileSync(path.join(second, "smart-hub"), "", { mode: 0o755 });
    expect(findOnPath("smart-hub", [first, second].join(path.delimiter))).toBe(path.join(second, "smart-hub"));
  });

  it("answers null instead of throwing when the toolchain is not installed", async () => {
    const service = new SmartHubService({ dir: tempDir(), pathEnv: tempDir() });
    expect(service.locate()).toBeNull();
    await expect(service.ensure()).resolves.toEqual({ kind: "missing" });
  });

  it("ignores empty PATH entries", () => {
    expect(findOnPath("smart-hub", `::${path.delimiter}`)).toBeNull();
  });
});

describe("profiles from GET /api/state (#419)", () => {
  it("reads both shapes the hub can report and drops the rest", () => {
    const profiles = readProfiles({
      profiles: [
        "alpha/dev/admin",
        { project: "beta", env: "stage", role: "editor" },
        { id: "gamma/prod/viewer" },
        { project: "incomplete" },
        "alpha/dev/admin",
        42
      ]
    });
    expect(profiles.map((profile) => profile.id)).toEqual([
      "alpha/dev/admin",
      "beta/stage/editor",
      "gamma/prod/viewer"
    ]);
    expect(profiles[0].parts).toEqual(["alpha", "dev", "admin"]);
  });

  it("is empty for anything that is not a profile list", () => {
    expect(readProfiles(null)).toEqual([]);
    expect(readProfiles({})).toEqual([]);
    expect(readProfiles({ profiles: "alpha/dev/admin" })).toEqual([]);
  });
});

describe("matching what the owner said (#419)", () => {
  const profiles = readProfiles({
    profiles: ["alpha/dev/admin", "alpha/prod/admin", "beta/dev/editor"]
  }) as HubProfile[];

  it("takes the profile the utterance names most of", () => {
    expect(pickProfile("залогінь мене в alpha prod", profiles)?.id).toBe("alpha/prod/admin");
    expect(pickProfile("log me into beta dev", profiles)?.id).toBe("beta/dev/editor");
  });

  it("stays unresolved when the words fit several profiles equally", () => {
    // "dev" alone matches two profiles: guessing would log into the wrong one.
    expect(pickProfile("залогінь мене в dev", profiles)).toBeNull();
  });

  it("stays unresolved when nothing matches", () => {
    expect(pickProfile("відкрий щось інше", profiles)).toBeNull();
    expect(pickProfile("alpha", [])).toBeNull();
  });

  it("ignores case and punctuation around the name", () => {
    expect(pickProfile("Alpha, Prod!", profiles)?.id).toBe("alpha/prod/admin");
  });
});

describe("window geometry (#417)", () => {
  const defaults = { width: 1100, height: 720, x: null, y: null };
  const min = { width: 560, height: 400 };

  it("keeps a remembered size and position", () => {
    expect(clampWindowState({ width: 900, height: 600, x: 12, y: 34 }, defaults, min)).toEqual({
      width: 900,
      height: 600,
      x: 12,
      y: 34
    });
  });

  it("falls back on junk and on sizes below the minimum", () => {
    expect(clampWindowState({ width: 10, height: "tall", x: "left" }, defaults, min)).toEqual(defaults);
    expect(clampWindowState(null, defaults, min)).toEqual(defaults);
  });
});

/**
 * The real `smart-hub` is not installed on every machine, so these drive a
 * stand-in that honours the contract Marshal depends on: write the port and
 * token 0600, then answer `GET /api/state` only for the right token.
 */
function fakeHub(dir: string, binDir: string, body = '{"profiles":["alpha/dev/admin"]}'): string {
  const script = path.join(binDir, "smart-hub");
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const server = http.createServer((req, res) => {
  if (req.headers["x-smart-hub-token"] !== "s3cret") { res.writeHead(401); res.end(); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(${JSON.stringify(body)});
});
server.listen(0, "127.0.0.1", () => {
  fs.mkdirSync(${JSON.stringify(dir)}, { recursive: true });
  fs.writeFileSync(path.join(${JSON.stringify(dir)}, "token"), "s3cret", { mode: 0o600 });
  fs.writeFileSync(path.join(${JSON.stringify(dir)}, "port"), String(server.address().port), { mode: 0o600 });
});
`,
    { mode: 0o755 }
  );
  return script;
}

describe("starting and reusing the server (#416)", () => {
  it("starts the hub, then answers with the loopback URL and the token", async () => {
    const dir = tempDir();
    const binDir = tempDir();
    fakeHub(dir, binDir);
    const service = new SmartHubService({ dir, pathEnv: binDir });
    try {
      const hub = await service.ensure();
      expect(hub.kind).toBe("running");
      if (hub.kind !== "running") return;
      expect(hub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(hub.token).toBe("s3cret");
      expect(readProfiles(await service.stateOf(hub))).toEqual([
        { id: "alpha/dev/admin", parts: ["alpha", "dev", "admin"] }
      ]);

      // A second call reuses what is already answering: no second server.
      const again = await service.ensure();
      expect(again).toEqual(hub);

      // Quitting Marshal must not leave the server behind.
      service.stop();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await service.stateOf(hub)).toBeNull();
    } finally {
      service.stop();
    }
  }, 30_000);

  it("says the hub is not running when the binary exits without serving", async () => {
    const dir = tempDir();
    const binDir = tempDir();
    fs.writeFileSync(path.join(binDir, "smart-hub"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const service = new SmartHubService({ dir, pathEnv: binDir });
    await expect(service.ensure()).resolves.toEqual({ kind: "stopped" });
  }, 30_000);

  it("ignores a stale port file and starts a server instead", async () => {
    const dir = tempDir();
    const binDir = tempDir();
    // Port 1 is privileged and never ours: nothing answers there.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "port"), "1", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "token"), "stale", { mode: 0o600 });
    fakeHub(dir, binDir);
    const service = new SmartHubService({ dir, pathEnv: binDir });
    try {
      const hub = await service.ensure();
      expect(hub.kind).toBe("running");
      if (hub.kind === "running") expect(hub.token).toBe("s3cret");
    } finally {
      service.stop();
    }
  }, 30_000);
});
