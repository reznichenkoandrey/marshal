import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChromeGuard, cleanDeviceName, guardMenuItems, isDeviceId, readDevices } from "../desktop/claude-code/chrome-guard.ts";
import {
  addChromeGuardHook,
  addMarshalHooks,
  CHROME_GUARD_MATCHER,
  hasChromeGuardHook,
  hasMarshalHooks,
  hookCommand,
  removeChromeGuardHook,
  removeMarshalHooks
} from "../desktop/claude-code/hook-installer.ts";
import { CHROME_GUARD_PATH, ClaudeHookService, PERMISSION_PATH, rejectHookRequest } from "../desktop/claude-code/hook-service.ts";

const MINE = "a1a1a1a1-0000-4000-8000-000000000001";
const THEIRS = "b2b2b2b2-0000-4000-8000-000000000002";
const UNKNOWN = "c3c3c3c3-0000-4000-8000-000000000003";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-guard-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function registry(): string {
  const file = path.join(tmpDir(), "chrome-devices.json");
  fs.writeFileSync(file, JSON.stringify({
    devices: {
      [MINE]: { name: "My Chrome", here: true, added: "2026-09-01T10:00:00" },
      [THEIRS]: { name: "Their Chrome", here: false, added: "2026-09-01T10:00:00" }
    }
  }));
  return file;
}

function call(action: string, sessionId = "s1", deviceId?: string): string {
  return JSON.stringify({
    session_id: sessionId,
    tool_name: `mcp__claude-in-chrome__${action}`,
    tool_input: deviceId === undefined ? {} : { deviceId }
  });
}

describe("chrome guard rules", () => {
  it("lets a session list browsers, and nothing else, before it picked one of ours", () => {
    const guard = new ChromeGuard(registry());
    expect(guard.judge(call("list_connected_browsers"))).toBeNull();
    expect(guard.judge(call("navigate"))).toContain("no browser is selected in this session");
    expect(guard.judge(call("navigate"))).toContain(MINE);
  });

  it("opens the browser tools only to the session that selected this computer's browser", () => {
    const guard = new ChromeGuard(registry());
    expect(guard.judge(call("select_browser", "s1", MINE))).toBeNull();
    expect(guard.judge(call("navigate", "s1"))).toBeNull();
    expect(guard.judge(call("navigate", "s2"))).toContain("no browser is selected");
  });

  it("refuses a browser registered as another computer's, and leaves the session unselected", () => {
    const guard = new ChromeGuard(registry());
    expect(guard.judge(call("select_browser", "s1", THEIRS))).toContain("NOT this computer's browser");
    expect(guard.judge(call("navigate", "s1"))).toContain("no browser is selected");
  });

  it("refuses an unknown browser and says how to put the question to the person", () => {
    const guard = new ChromeGuard(registry(), "/bin/sh '/x/marshal-chrome-guard.sh' add");
    const refusal = guard.judge(call("select_browser", "s1", UNKNOWN));
    expect(refusal).toContain("is not registered on this computer");
    expect(refusal).toContain(`/bin/sh '/x/marshal-chrome-guard.sh' add ${UNKNOWN} "<the browser's name>"`);
    expect(guard.judge(call("select_browser", "s1"))).toContain("needs a deviceId");
  });

  it("never allows switch_browser, selected or not", () => {
    const guard = new ChromeGuard(registry());
    guard.judge(call("select_browser", "s1", MINE));
    expect(guard.judge(call("switch_browser", "s1"))).toContain("EVERY paired Chrome");
  });

  it("drops a session's access the moment its browser is marked as not here", () => {
    const file = registry();
    const guard = new ChromeGuard(file);
    guard.judge(call("select_browser", "s1", MINE));
    guard.setDevice(MINE, "", false);
    expect(guard.judge(call("navigate", "s1"))).toContain("no browser is selected");
    expect(readDevices(file)[MINE]).toMatchObject({ name: "My Chrome", here: false, added: "2026-09-01T10:00:00" });
  });

  it("fails closed on what it cannot read or understand", () => {
    const file = registry();
    const guard = new ChromeGuard(file);
    expect(guard.judge("not json")).toContain("not a tool call");
    // No session id: the selection cannot be tied to anyone, so it is not remembered.
    expect(guard.judge(JSON.stringify({ tool_name: "mcp__claude-in-chrome__select_browser", tool_input: { deviceId: MINE } }))).toBeNull();
    expect(guard.judge(JSON.stringify({ tool_name: "mcp__claude-in-chrome__navigate" }))).toContain("no browser is selected");
    fs.writeFileSync(file, "{ broken");
    expect(guard.judge(call("select_browser", "s1", MINE))).toContain("registry cannot be read");
    expect(() => guard.setDevice(MINE, "x", true)).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{ broken");
  });

  it("stays out of the way of every other tool, and with no registry knows no browser", () => {
    const guard = new ChromeGuard(path.join(tmpDir(), "absent.json"));
    expect(guard.judge(JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: {} }))).toBeNull();
    expect(guard.judge(call("select_browser", "s1", MINE))).toContain("No browser is registered as this computer's yet");
  });

  it("records the person's answer next to whatever else the file holds", () => {
    const file = registry();
    fs.writeFileSync(file, JSON.stringify({ version: 1, ...JSON.parse(fs.readFileSync(file, "utf8")) }));
    new ChromeGuard(file).setDevice(UNKNOWN, "New Chrome", true);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.version).toBe(1);
    expect(saved.devices[UNKNOWN]).toMatchObject({ name: "New Chrome", here: true });
    expect(saved.devices[THEIRS]).toMatchObject({ name: "Their Chrome", here: false });
  });

  it("takes only a real device id and a one-line name from the agent", () => {
    expect(isDeviceId(MINE)).toBe(true);
    expect(isDeviceId("../../etc")).toBe(false);
    expect(isDeviceId("")).toBe(false);
    expect(cleanDeviceName("  Chrome\n(profile)\t1 ")).toBe("Chrome (profile) 1");
    expect(cleanDeviceName("x".repeat(200))).toHaveLength(80);
  });
});

describe("chrome guard tray menu", () => {
  const text = { on: "Guard", browsers: "Browsers:", none: "None yet" };

  it("offers the switch and each browser as a checkbox that flips to the opposite", () => {
    const calls: unknown[] = [];
    const act = {
      setInstalled: (installed: boolean) => calls.push(["installed", installed]),
      setHere: (id: string, here: boolean) => calls.push([id, here])
    };
    const items = guardMenuItems(false, readDevices(registry()), text, act);
    expect(items.map((item) => [item.label, item.checked])).toEqual([
      ["Guard", false],
      [undefined, undefined],
      ["Browsers:", undefined],
      ["My Chrome · a1a1a1a1", true],
      ["Their Chrome · b2b2b2b2", false]
    ]);
    for (const item of items) item.click?.();
    expect(calls).toEqual([["installed", true], [MINE, false], [THEIRS, true]]);
    expect(guardMenuItems(true, {}, text, act).map((item) => item.label)).toEqual(["Guard", undefined, "None yet"]);
  });
});

describe("chrome guard hook entry", () => {
  const userSettings = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/.claude/hooks/branch-guard.sh", timeout: 3 }] }],
      Stop: [{ hooks: [{ type: "command", command: "~/.claude/hooks/save.sh", async: true }] }]
    }
  };
  const guardCommand = hookCommand("/Users/me/Library/Application Support/Marshal/claude-code/marshal-chrome-guard.sh");
  const hookScript = hookCommand("/Users/me/Library/Application Support/Marshal/claude-code/marshal-claude-hook.sh");

  it("adds one synchronous PreToolUse entry for the Chrome tools and removes exactly that", () => {
    const next = addChromeGuardHook(addChromeGuardHook(userSettings, guardCommand), guardCommand);
    const groups = (next.hooks as Record<string, unknown[]>).PreToolUse;
    expect(groups).toEqual([
      userSettings.hooks.PreToolUse[0],
      { matcher: CHROME_GUARD_MATCHER, hooks: [{ type: "command", command: guardCommand, timeout: 10 }] }
    ]);
    expect(hasChromeGuardHook(next)).toBe(true);
    expect(removeChromeGuardHook(next)).toEqual(userSettings);
  });

  it("is installed and removed apart from the session hooks", () => {
    const both = addMarshalHooks(addChromeGuardHook(userSettings, guardCommand), hookScript);
    const withoutHooks = removeMarshalHooks(both);
    expect(hasMarshalHooks(withoutHooks)).toBe(false);
    expect(hasChromeGuardHook(withoutHooks)).toBe(true);
    const withoutGuard = removeChromeGuardHook(both);
    expect(hasMarshalHooks(withoutGuard)).toBe(true);
    expect(hasChromeGuardHook(withoutGuard)).toBe(false);
  });
});

describe("chrome guard through the real script", () => {
  type Result = { code: number; stdout: string; stderr: string };
  // Async on purpose: a sync spawn blocks the server it is posting to.
  const run = (script: string, args: string[], stdin = ""): Promise<Result> => new Promise((resolve) => {
    const child = execFile("/bin/sh", [script, ...args], (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as NodeJS.ErrnoException).code ?? 1) : 0, stdout, stderr });
    });
    child.stdin?.end(stdin);
  });

  it("accepts the guard's requests like the hook's own", () => {
    const ok = { method: "POST", url: CHROME_GUARD_PATH, host: "127.0.0.1:4000", origin: undefined, authorization: "Bearer t" };
    expect(rejectHookRequest(ok, 4000, "t")).toBeNull();
    expect(rejectHookRequest({ ...ok, origin: "https://evil.example" }, 4000, "t")).toBe(403);
    expect(rejectHookRequest({ ...ok, authorization: "Bearer x" }, 4000, "t")).toBe(401);
  });

  it("exits 0 on allow, 2 with the reason on a refusal, 2 when Marshal is down or has no guard", async () => {
    const service = new ClaudeHookService(tmpDir(), () => {});
    const guard = new ChromeGuard(registry());
    await service.start();
    try {
      // No guard wired: silence must not read as permission.
      expect((await run(service.guardScriptPath, [], call("list_connected_browsers"))).code).toBe(2);

      service.setChromeGuard({ judge: (raw) => guard.judge(raw) ?? "allow", propose: async () => "" });
      expect(await run(service.guardScriptPath, [], call("select_browser", "s1", MINE))).toMatchObject({ code: 0, stderr: "" });
      expect((await run(service.guardScriptPath, [], call("navigate", "s1"))).code).toBe(0);
      const refused = await run(service.guardScriptPath, [], call("select_browser", "s1", THEIRS));
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("chrome-guard: ");
      expect(refused.stderr).toContain("NOT this computer's browser");
    } finally {
      service.stop();
    }
    const down = await run(service.guardScriptPath, [], call("navigate", "s1"));
    expect(down.code).toBe(2);
    expect(down.stderr).toContain("Marshal is not running");
  });

  it("hands `add` to the person: the agent's words reach the dialog, the answer comes back", async () => {
    const service = new ClaudeHookService(tmpDir(), () => {});
    const proposals: string[] = [];
    service.setChromeGuard({
      judge: () => "allow",
      propose: async (form) => {
        proposals.push(form);
        return "Recorded.";
      }
    });
    await service.start();
    try {
      const added = await run(service.guardScriptPath, ["add", UNKNOWN, "Chrome & \"quotes\" + spaces"]);
      expect(added).toMatchObject({ code: 0, stdout: "Recorded." });
      const params = new URLSearchParams(proposals[0]);
      expect(params.get("id")).toBe(UNKNOWN);
      expect(params.get("name")).toBe("Chrome & \"quotes\" + spaces");
      expect((await run(service.guardScriptPath, ["add", UNKNOWN])).code).toBe(1);
    } finally {
      service.stop();
    }
  });

  it("keeps the permission and guard routes out of the assistant's hands", async () => {
    const dir = tmpDir();
    const asked: string[] = [];
    const service = new ClaudeHookService(dir, () => {}, async (raw) => {
      asked.push(raw);
      return "{}";
    });
    const routed: string[] = [];
    service.setAssistantRoutes({
      respond: (_method, route, _body, res) => {
        routed.push(route);
        res.writeHead(200).end("assistant");
      }
    });
    await service.start();
    try {
      const port = fs.readFileSync(path.join(dir, "port"), "utf8").trim();
      const auth = fs.readFileSync(path.join(dir, "auth-header"), "utf8").trim().replace("Authorization: ", "");
      const post = (url: string) => fetch(`http://127.0.0.1:${port}${url}`, { method: "POST", headers: { Authorization: auth }, body: "{}" }).then((res) => res.text());
      expect(await post(PERMISSION_PATH)).toBe("{}");
      expect(await post(CHROME_GUARD_PATH)).not.toBe("assistant");
      expect(await post("/assistant/sessions")).toBe("assistant");
      expect(asked).toEqual(["{}"]);
      expect(routed).toEqual(["sessions"]);
    } finally {
      service.stop();
    }
  });
});
