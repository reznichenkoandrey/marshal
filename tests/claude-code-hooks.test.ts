import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSummaryRequest } from "../desktop/claude-code/answer-summary.ts";
import { EventDeduper, eventKey, isFreshSpoolEntry, parseHookPayload, type HookEvent } from "../desktop/claude-code/hook-events.ts";
import {
  addMarshalHooks,
  hasMarshalHooks,
  hookCommand,
  installHooks,
  needsPermissionHook,
  removeMarshalHooks,
  uninstallHooks
} from "../desktop/claude-code/hook-installer.ts";
import { ClaudeHookService, HOOK_PATH, rejectHookRequest } from "../desktop/claude-code/hook-service.ts";
import { SessionNotifier } from "../desktop/claude-code/session-notifier.ts";
import type { ClaudeSession } from "../desktop/claude-code/registry.ts";

// Shape of a real ~/.claude/settings.json: other tools already own Stop and
// Notification hooks, some async, some without a matcher.
const userSettings = {
  theme: "dark",
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/.claude/hooks/branch-guard.sh", timeout: 3 }] }],
    Stop: [
      { hooks: [{ type: "command", command: "~/.claude/hooks/handoff/save.sh stop", timeout: 2, async: true }] },
      { hooks: [{ type: "command", command: "node \"/Applications/Other.app/hook.js\"", async: true }] }
    ],
    Notification: [{ hooks: [{ type: "command", command: "node \"/Applications/Other.app/hook.js\"", async: true }] }]
  },
  statusLine: { type: "command", command: "~/.claude/statusline.sh" }
};
const command = hookCommand("/Users/me/Library/Application Support/Marshal/claude-code/marshal-claude-hook.sh");

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-hooks-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("hook installer", () => {
  it("appends Marshal's hooks after the user's own and leaves everything else alone", () => {
    const next = addMarshalHooks(userSettings, command);
    const hooks = next.hooks as typeof userSettings.hooks;
    expect(hooks.Stop).toHaveLength(3);
    expect(hooks.Stop.slice(0, 2)).toEqual(userSettings.hooks.Stop);
    expect(hooks.Stop[2]).toEqual({ hooks: [{ type: "command", command, async: true }] });
    expect(hooks.Notification[1]).toEqual({ hooks: [{ type: "command", command, async: true }] });
    expect(hooks.PreToolUse).toEqual(userSettings.hooks.PreToolUse);
    expect(next.statusLine).toEqual(userSettings.statusLine);
    expect(hasMarshalHooks(next)).toBe(true);
  });

  it("does not duplicate on a second install", () => {
    const twice = addMarshalHooks(addMarshalHooks(userSettings, command), command);
    expect((twice.hooks as typeof userSettings.hooks).Stop).toHaveLength(3);
  });

  it("uninstall restores the user's settings exactly", () => {
    expect(removeMarshalHooks(addMarshalHooks(userSettings, command))).toEqual(userSettings);
  });

  it("uninstall keeps a user command that shares a group with Marshal's", () => {
    const shared = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }, { type: "command", command }] }] } };
    expect(removeMarshalHooks(shared)).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } });
  });

  it("adds a synchronous PermissionRequest hook and upgrades an older install (#375)", () => {
    const next = addMarshalHooks(userSettings, command);
    expect((next.hooks as Record<string, unknown>).PermissionRequest).toEqual([
      { hooks: [{ type: "command", command: `${command} permission`, timeout: 60 }] }
    ]);
    expect(needsPermissionHook(next)).toBe(false);
    const older = structuredClone(next);
    delete (older.hooks as Record<string, unknown>).PermissionRequest;
    expect(needsPermissionHook(older)).toBe(true);
    expect(needsPermissionHook(userSettings)).toBe(false);
  });

  it("install then uninstall on a file with no hooks leaves no hooks key", () => {
    expect(removeMarshalHooks(addMarshalHooks({ theme: "dark" }, command))).toEqual({ theme: "dark" });
  });

  it("round-trips a real file, keeping indentation and refusing to touch broken JSON", () => {
    const dir = tmpDir();
    const file = path.join(dir, "settings.json");
    const original = `${JSON.stringify(userSettings, null, 4)}\n`;
    fs.writeFileSync(file, original);
    installHooks("/x/marshal-claude-hook.sh", file);
    expect(fs.readFileSync(file, "utf8")).toContain('\n    "hooks"');
    expect(hasMarshalHooks(JSON.parse(fs.readFileSync(file, "utf8")))).toBe(true);
    uninstallHooks(file);
    expect(fs.readFileSync(file, "utf8")).toBe(original);

    fs.writeFileSync(file, "{ broken");
    expect(() => installHooks("/x/marshal-claude-hook.sh", file)).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{ broken");
  });
});

describe("hook payloads", () => {
  const base = { session_id: "s1", transcript_path: "/t.jsonl", cwd: "/Users/me/htdocs/marshal" };

  it("reads a Stop with the last answer", () => {
    expect(parseHookPayload(JSON.stringify({ ...base, hook_event_name: "Stop", last_assistant_message: "Done." })))
      .toEqual({ type: "stop", sessionId: "s1", cwd: base.cwd, lastMessage: "Done." });
  });

  it("maps permission and input notifications, and ignores the rest", () => {
    const note = (notification_type: string) =>
      parseHookPayload(JSON.stringify({ ...base, hook_event_name: "Notification", notification_type, message: "m" }));
    expect(note("permission_prompt")).toMatchObject({ type: "attention", reason: "confirmation" });
    expect(note("elicitation_dialog")).toMatchObject({ type: "attention", reason: "input" });
    expect(note("idle_prompt")).toBeNull();
    expect(note("auth_success")).toBeNull();
    expect(parseHookPayload("nope")).toBeNull();
  });

  it("dedups the same event and forgets it after the TTL", () => {
    const deduper = new EventDeduper(1000);
    const key = eventKey("s1", "{}");
    expect(deduper.accept(key, 0)).toBe(true);
    expect(deduper.accept(key, 500)).toBe(false);
    expect(deduper.accept(eventKey("s1", "{ }"), 500)).toBe(true);
    expect(deduper.accept(key, 2000)).toBe(true);
  });

  it("drops spool entries older than 15 minutes", () => {
    expect(isFreshSpoolEntry(0, 15 * 60_000)).toBe(true);
    expect(isFreshSpoolEntry(0, 15 * 60_000 + 1)).toBe(false);
  });
});

describe("hook endpoint", () => {
  const ok = { method: "POST", url: HOOK_PATH, host: "127.0.0.1:4000", origin: undefined, authorization: "Bearer t" };

  it("accepts the hook script's request only", () => {
    expect(rejectHookRequest(ok, 4000, "t")).toBeNull();
    expect(rejectHookRequest({ ...ok, origin: "https://evil.example" }, 4000, "t")).toBe(403);
    expect(rejectHookRequest({ ...ok, origin: "http://127.0.0.1:4000" }, 4000, "t")).toBe(403);
    expect(rejectHookRequest({ ...ok, host: "evil.example:4000" }, 4000, "t")).toBe(403);
    expect(rejectHookRequest({ ...ok, authorization: "Bearer x" }, 4000, "t")).toBe(401);
    expect(rejectHookRequest({ ...ok, method: "GET" }, 4000, "t")).toBe(404);
  });

  it("delivers through the real hook script, spools while Marshal is down, replays once", async () => {
    const dir = tmpDir();
    const events: HookEvent[] = [];
    const service = new ClaudeHookService(dir, (event) => events.push(event));
    const stop = JSON.stringify({ session_id: "s1", cwd: "/p", hook_event_name: "Stop", last_assistant_message: "Done." });
    // Async on purpose: a sync spawn blocks the server it is posting to.
    const runHook = (payload: string) => new Promise<void>((resolve, reject) => {
      const child = execFile("/bin/sh", [service.scriptPath], (err) => (err ? reject(err) : resolve()));
      child.stdin?.end(payload);
    });

    await service.start();
    await runHook(stop);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(fs.existsSync(path.join(dir, "spool"))).toBe(false);
    service.stop();

    // Marshal down: the script spools. A copy of that file is a duplicate.
    const second = JSON.stringify({ session_id: "s2", cwd: "/p", hook_event_name: "Stop", last_assistant_message: "Ok." });
    await runHook(second);
    const spool = path.join(dir, "spool");
    const [file] = fs.readdirSync(spool);
    fs.copyFileSync(path.join(spool, file), path.join(spool, `0-${file}`));
    fs.writeFileSync(path.join(spool, "1-old.json"), stop.replace("s1", "s3"));
    fs.utimesSync(path.join(spool, "1-old.json"), new Date(0), new Date(0));

    await service.start();
    service.stop();
    expect(events.map((e) => e.sessionId)).toEqual(["s1", "s2"]);
    expect(fs.readdirSync(spool)).toEqual([]);
  });
});

describe("session notifier", () => {
  const session = (status: ClaudeSession["status"]): ClaudeSession => ({
    pid: 7, sessionId: "s1", name: "Feature 1494", cwd: "/p", status, waitingFor: null,
    entrypoint: "cli", socketPath: "/s", startedAt: 0, statusUpdatedAt: null
  });

  function setup(status: ClaudeSession["status"], summary: string | null = "Tests pass.") {
    const notes: string[] = [];
    let fire: (() => void) | null = null;
    let current = session(status);
    const notifier = new SessionNotifier({
      notify: (title, body) => notes.push(`${title} | ${body}`),
      summarize: async () => summary,
      findSession: () => current,
      focus: () => undefined,
      setTimer: (fn) => {
        fire = fn;
        return 1 as unknown as NodeJS.Timeout;
      },
      clearTimer: () => {
        fire = null;
      }
    });
    return { notes, notifier, fire: () => fire?.(), setStatus: (s: ClaudeSession["status"]) => { current = session(s); } };
  }

  it("summarizes a long answer and falls back when there is no summary", async () => {
    const long = "line one\nline two";
    const a = setup("idle");
    await a.notifier.handle({ type: "stop", sessionId: "s1", cwd: "/p", lastMessage: long });
    const b = setup("idle", null);
    await b.notifier.handle({ type: "stop", sessionId: "s1", cwd: "/p", lastMessage: long });
    expect([...a.notes, ...b.notes]).toEqual([
      "Feature 1494: finished | Tests pass.",
      "Feature 1494: finished | Finished, check the session."
    ]);
  });

  it("reminds once if the session still waits, not if it was answered", async () => {
    const waiting = setup("waiting");
    await waiting.notifier.handle({ type: "attention", sessionId: "s1", cwd: "/p", reason: "confirmation", message: "Allow Bash?" });
    waiting.fire();
    expect(waiting.notes).toEqual([
      "Feature 1494 needs your confirmation | Allow Bash?",
      "Feature 1494 is still waiting | Allow Bash?"
    ]);

    const answered = setup("waiting");
    await answered.notifier.handle({ type: "attention", sessionId: "s1", cwd: "/p", reason: "input", message: "Which one?" });
    answered.setStatus("busy");
    answered.fire();
    expect(answered.notes).toEqual(["Feature 1494 needs your input | Which one?"]);
  });
});

describe("answer summary prompt", () => {
  it("follows the answer's language on auto and pins it otherwise", () => {
    expect(buildSummaryRequest("Усі тести проходять, PR відкрито.", "auto").user).toContain("Write it in Ukrainian.");
    expect(buildSummaryRequest("All tests pass.", "auto").user).toContain("Write it in English.");
    expect(buildSummaryRequest("All tests pass.", "uk").user).toContain("Write it in Ukrainian.");
  });
});
