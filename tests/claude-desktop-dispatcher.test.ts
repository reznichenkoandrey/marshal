import { execFile } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AssistantDispatcher, type DispatcherDeps } from "../desktop/assistant/dispatcher.ts";
import {
  appToolRefusal,
  buildHelperScript,
  DESKTOP_SPAWN_PROMPT,
  DISPATCHER_SETTINGS,
  DISPATCHER_START_PROMPT,
  sessionsForDispatcher
} from "../desktop/assistant/dispatcher-files.ts";
import { newSessionUrl, openDesktopSession, readSessionSetup, setupMismatch, type DesktopSessionDeps } from "../desktop/claude-code/desktop-session.ts";
import { VoiceTimeline } from "../desktop/assistant/voice-timing.ts";
import type { FocusProbeResult } from "../desktop/dictation/focus-paste.ts";
import { ClaudeHookService } from "../desktop/claude-code/hook-service.ts";
import type { ClaudeSession } from "../desktop/claude-code/registry.ts";
import { usesHarbor } from "../desktop/claude-code/harbor.ts";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-desktop-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function session(overrides: Partial<ClaudeSession>): ClaudeSession {
  return {
    pid: 1, sessionId: "s", name: "s", cwd: "/p", status: "idle", waitingFor: null,
    entrypoint: "claude-desktop", socketPath: "/tmp/s.sock", startedAt: 0, statusUpdatedAt: null,
    ...overrides
  };
}

const CLAUDE_FOCUSED = { isTextInput: true, frontmostPath: "/Applications/Claude.app" } as FocusProbeResult;
const ELSEWHERE = { isTextInput: true, frontmostPath: "/Applications/Ghostty.app" } as FocusProbeResult;

describe("opening a Claude desktop session (#437)", () => {
  it("builds the new-session deep link with the prompt and folder", () => {
    expect(newSessionUrl("/htdocs/my project", "Reply \"ready\" & wait")).toBe(
      "claude://code/new?q=Reply+%22ready%22+%26+wait&folder=%2Fhtdocs%2Fmy+project"
    );
  });

  function deps(probes: FocusProbeResult[]): DesktopSessionDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      openUrl: async (url) => void calls.push(`open ${url}`),
      probe: async () => probes.shift() ?? ELSEWHERE,
      sendKey: async (key) => void calls.push(`key ${key}`),
      activate: async (app) => void calls.push(`activate ${app}`),
      wait: async () => undefined
    };
  }

  it("presses Return once Claude's composer has focus, then returns the owner to their app", async () => {
    const stub = deps([ELSEWHERE, ELSEWHERE, CLAUDE_FOCUSED]);
    expect(await openDesktopSession("/p", "hi", false, stub)).toBe("ok");
    expect(stub.calls).toEqual([`open ${newSessionUrl("/p", "hi")}`, "key return", "activate /Applications/Ghostty.app"]);
  });

  it("never presses Return outside Claude, and stays in Claude when revealed", async () => {
    const lost = deps([ELSEWHERE]);
    expect(await openDesktopSession("/p", "hi", false, lost)).toMatch(/press Return/);
    expect(lost.calls.some((call) => call.startsWith("key"))).toBe(false);

    const revealed = deps([ELSEWHERE, CLAUDE_FOCUSED]);
    expect(await openDesktopSession("/p", "hi", true, revealed)).toBe("ok");
    expect(revealed.calls.some((call) => call.startsWith("activate"))).toBe(false);
  });
});

describe("the dispatcher's Claude app tools (#437)", () => {
  const roots = ["/htdocs"];
  const dispatcherDir = "/data/assistant/dispatcher";
  const live = [
    session({ name: "marshal", cwd: "/htdocs/marshal", hostSessionId: "local_a" }),
    session({ name: "work", cwd: "/axiomvalley/shop", hostSessionId: "local_w" }),
    session({ name: "marshal-dispatcher", cwd: dispatcherDir, hostSessionId: "local_d" })
  ];
  const call = (tool: string, input: Record<string, unknown> = {}) => JSON.stringify({ tool_name: `mcp__ccd_session_mgmt__${tool}`, tool_input: input });

  it("lets through only live sessions under the routing roots", () => {
    expect(appToolRefusal(call("archive_session", { session_id: "local_a" }), live, roots, dispatcherDir)).toBeNull();
    expect(appToolRefusal(call("set_session_model", { session_id: "local_w", model: "opus" }), live, roots, dispatcherDir)).toMatch(/Outside/);
    expect(appToolRefusal(call("get_session", { session_id: "local_gone" }), live, roots, dispatcherDir)).toMatch(/Not a live/);
    expect(appToolRefusal(call("archive_session", { session_id: "self" }), live, roots, dispatcherDir)).toMatch(/another/);
    expect(appToolRefusal(call("archive_session", { session_id: "local_d" }), live, [...roots, "/data"], dispatcherDir)).toMatch(/another/);
    expect(appToolRefusal(call("archive_session", { session_id: "local_a" }), live, [], dispatcherDir)).toMatch(/Settings/);
  });

  it("allows the session list, refuses transcripts and anything unknown, fails closed on garbage", () => {
    expect(appToolRefusal(call("list_sessions"), live, roots, dispatcherDir)).toBeNull();
    expect(appToolRefusal(call("list_events", { session_id: "local_a" }), live, roots, dispatcherDir)).toMatch(/not allowed/);
    expect(appToolRefusal(call("delete_session", { session_id: "local_a" }), live, roots, dispatcherDir)).toMatch(/not allowed/);
    expect(appToolRefusal("{not json", live, roots, dispatcherDir)).toMatch(/Unreadable/);
  });

  it("denies transcript tools in settings and gates the rest through the helper", () => {
    expect(DISPATCHER_SETTINGS.permissions.deny).toEqual(expect.arrayContaining([
      "mcp__ccd_session_mgmt__list_events",
      "mcp__ccd_session_mgmt__search_session_transcripts",
      "mcp__ccd_session__start_session"
    ]));
    expect(DISPATCHER_SETTINGS.hooks.PreToolUse[0]?.hooks[0]?.command).toBe("\"$CLAUDE_PROJECT_DIR\"/marshal gate");
  });

  it("gives desktop sessions their app id", () => {
    const listed = sessionsForDispatcher([...live, session({ name: "cli", cwd: "/htdocs/x", entrypoint: "cli" })], dispatcherDir);
    expect(listed.map((s) => s.id)).toEqual(["local_a", "local_w", undefined]);
  });
});

describe("host", () => {
  it("general still prefers Harbor when the dispatcher lives in the app", () => {
    expect(usesHarbor("claude-desktop", true)).toBe(true);
    expect(usesHarbor("claude-desktop", false)).toBe(false);
  });
});

describe("dispatcher in Claude desktop (#437)", () => {
  function setup(live: ClaudeSession[], overrides: Partial<DispatcherDeps> = {}) {
    const userDataDir = tmpDir();
    const hookDir = path.join(userDataDir, "claude-code");
    const said: string[] = [];
    const replies: string[] = [];
    const opened: string[] = [];
    const killed: number[] = [];
    const deps: DispatcherDeps = {
      userDataDir,
      hookDir: () => hookDir,
      settings: () => ({ model: "haiku", generalDir: "", generalMode: "bypass", routingRoots: ["/htdocs"] }),
      liveSessions: () => live,
      context: async () => "off",
      say: (text) => said.push(text),
      ask: async () => null,
      runAction: async () => "",
      announce: () => undefined,
      focus: () => undefined,
      insert: async () => "",
      reply: async (target, text) => {
        replies.push(`${target.name}: ${text}`);
        return "ok";
      },
      runAppleScript: async () => undefined,
      kill: (pid) => killed.push(pid),
      claudeStatePath: path.join(userDataDir, ".claude.json"),
      desktop: {
        enabled: () => true,
        open: async (cwd, prompt) => {
          opened.push(`${cwd}: ${prompt}`);
          return "ok";
        },
        openUrl: async (url) => void opened.push(url)
      },
      ...overrides
    };
    const dispatcher = new AssistantDispatcher(deps);
    return { dispatcher, said, replies, opened, killed, hookDir };
  }

  it("opens the dispatcher through the app, keeps general out of it", async () => {
    const live: ClaudeSession[] = [session({ name: "general", cwd: "/g", entrypoint: "cli" })];
    const { dispatcher, opened } = setup(live);
    await dispatcher.start();
    expect(opened).toEqual([`${dispatcher.dispatcherDir}: ${DISPATCHER_START_PROMPT}`]);
  });

  it("replaces a Terminal dispatcher once the host is the app", async () => {
    const live: ClaudeSession[] = [session({ pid: 8, name: "general", cwd: "/g", entrypoint: "cli" })];
    const { dispatcher, opened, killed } = setup(live);
    live.push(session({ pid: 5, name: "marshal-dispatcher", cwd: dispatcher.dispatcherDir, entrypoint: "cli" }));
    await dispatcher.start();
    expect(killed).toEqual([5]);
    expect(opened).toEqual([`${dispatcher.dispatcherDir}: ${DISPATCHER_START_PROMPT}`]);
  });

  it("wakes an idle desktop dispatcher, never kills it, and resumes it by its remembered id", async () => {
    const live: ClaudeSession[] = [];
    const { dispatcher, replies, opened, killed } = setup(live);
    live.push(
      session({ pid: 7, name: "Voice dispatcher", cwd: dispatcher.dispatcherDir, hostSessionId: "local_d" }),
      session({ pid: 8, name: "general", cwd: "/g", entrypoint: "cli" })
    );
    await dispatcher.start();
    expect(replies).toEqual([`Voice dispatcher: ${DISPATCHER_START_PROMPT}`]);
    dispatcher.stop();
    expect(killed).toEqual([]);

    // The app ended the process; the next start resumes the same session instead of opening another.
    live.splice(0, 1);
    const resumed = setup(live);
    fs.mkdirSync(path.dirname(resumed.dispatcher.dispatcherDir), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(resumed.dispatcher.dispatcherDir), "desktop-dispatcher-id"), "local_d\n");
    const started = resumed.dispatcher.start();
    setTimeout(() => live.unshift(session({ pid: 9, name: "Voice dispatcher", cwd: resumed.dispatcher.dispatcherDir, hostSessionId: "local_d" })), 10);
    await started;
    expect(resumed.opened).toEqual(["claude://code/continue?session=local_d"]);
    expect(resumed.replies).toEqual([`Voice dispatcher: ${DISPATCHER_START_PROMPT}`]);
    expect(opened).toEqual([]);
  });

  it("remembers a freshly opened desktop dispatcher once its monitor connects", () => {
    const live: ClaudeSession[] = [];
    const { dispatcher } = setup(live);
    live.push(session({ pid: 7, name: "Voice dispatcher", cwd: dispatcher.dispatcherDir, hostSessionId: "local_new" }));
    fs.mkdirSync(path.dirname(dispatcher.dispatcherDir), { recursive: true });
    const res = { writeHead: () => res, flushHeaders: () => undefined, write: () => true, on: () => res };
    dispatcher.respond("GET", "commands", "", res as unknown as http.ServerResponse);
    expect(fs.readFileSync(path.join(path.dirname(dispatcher.dispatcherDir), "desktop-dispatcher-id"), "utf8")).toBe("local_new\n");
  });

  it("spawns a project session in the app and finds it by folder", async () => {
    const live: ClaudeSession[] = [];
    const { dispatcher, opened } = setup(live, {
      desktop: {
        enabled: () => true,
        open: async (cwd, prompt) => {
          opened.push(`${cwd}: ${prompt}`);
          live.push(session({ sessionId: "new", name: "Opened by voice", cwd }));
          return "ok";
        },
        openUrl: async () => undefined
      }
    });
    live.push(session({ name: "marshal", sessionId: "m", cwd: "/htdocs/marshal" }));
    const reply = await (dispatcher as unknown as { spawn: (args: string[]) => Promise<string> }).spawn(["marshal"]);
    expect(reply).toBe("Ready: Opened by voice");
    expect(opened).toEqual([`/htdocs/marshal: ${DESKTOP_SPAWN_PROMPT}`]);
  });

  it("answers the helper's gate from the PreToolUse payload", async () => {
    const live = [session({ name: "marshal", cwd: "/htdocs/marshal", hostSessionId: "local_a" })];
    const { dispatcher, hookDir } = setup(live);
    const service = new ClaudeHookService(hookDir, () => undefined);
    service.setAssistantRoutes(dispatcher);
    await service.start();
    const gate = (payload: string) => new Promise<{ code: number; stderr: string }>((resolve) => {
      const file = path.join(path.dirname(hookDir), "helper.sh");
      fs.writeFileSync(file, buildHelperScript(hookDir), { mode: 0o700 });
      const child = execFile("/bin/sh", [file, "gate"], (err, _stdout, stderr) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stderr }));
      child.stdin?.end(payload);
    });
    try {
      const archive = (id: string) => JSON.stringify({ tool_name: "mcp__ccd_session_mgmt__archive_session", tool_input: { session_id: id } });
      expect(await gate(archive("local_a"))).toEqual({ code: 0, stderr: "" });
      const refused = await gate(archive("local_x"));
      expect(refused.code).toBe(2);
      expect(refused.stderr).toMatch(/Not a live session/);
    } finally {
      service.stop();
    }
    // Marshal gone: the call is blocked, not let through.
    expect((await gate("{}")).code).toBe(2);
  });
});

describe("the desktop dispatcher's model and mode (#448)", () => {
  const transcript = [
    '{"type":"assistant","message":{"model":"claude-opus-5-5"}',
    JSON.stringify({ type: "user", permissionMode: "default", message: { content: "x" } }),
    JSON.stringify({ type: "user", permissionMode: "bypassPermissions", message: { content: "Start the monitor" } }),
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [] } }),
    JSON.stringify({ type: "assistant", message: { model: "<synthetic>", content: [] } }),
    ""
  ].join("\n");

  it("reads the last answer's model and the last turn's mode, past API errors and a cut first line", () => {
    expect(readSessionSetup(transcript)).toEqual({ model: "claude-opus-5-5", permissionMode: "bypassPermissions" });
    expect(readSessionSetup("")).toEqual({ model: null, permissionMode: null });
  });

  it("names the menu only when the session runs on something else than Settings ask for", () => {
    expect(setupMismatch({ model: "claude-haiku-5-5", permissionMode: "bypassPermissions" }, "haiku", "bypass")).toBeNull();
    expect(setupMismatch({ model: null, permissionMode: null }, "haiku", "bypass")).toBeNull();
    expect(setupMismatch({ model: "claude-opus-5-5", permissionMode: "bypassPermissions" }, "haiku", "bypass")).toBe(
      "Диспетчер у застосунку Claude має модель Opus 5.5 замість Haiku. Перемкни це в меню під полем вводу його сесії, один раз."
    );
    expect(setupMismatch({ model: "claude-haiku-5-5", permissionMode: "default" }, "claude-haiku-5-5", "bypass")).toContain("режим дозволів не Bypass permissions");
  });

  it("warns once per session when its monitor connects, not as an answer", () => {
    const userDataDir = tmpDir();
    const projectsDir = tmpDir();
    const warned: string[] = [];
    const said: string[] = [];
    const dispatcherDir = path.join(userDataDir, "assistant", "dispatcher");
    const live = [session({ pid: 7, sessionId: "d1", name: "Voice dispatcher", cwd: dispatcherDir, hostSessionId: "local_d" })];
    fs.mkdirSync(path.join(projectsDir, "x"), { recursive: true });
    fs.writeFileSync(path.join(projectsDir, "x", "d1.jsonl"), transcript);
    const dispatcher = new AssistantDispatcher({
      userDataDir,
      hookDir: () => path.join(userDataDir, "claude-code"),
      settings: () => ({ model: "haiku", generalDir: "", generalMode: "bypass", routingRoots: [] }),
      liveSessions: () => live,
      context: async () => "off",
      say: (text) => said.push(text),
      warn: (text) => warned.push(text),
      projectsDir,
      ask: async () => null,
      runAction: async () => "",
      announce: () => undefined,
      focus: () => undefined,
      insert: async () => "",
      reply: async () => "ok",
      desktop: { enabled: () => true, open: async () => "ok", openUrl: async () => undefined }
    });
    fs.mkdirSync(dispatcherDir, { recursive: true });
    const res = { writeHead: () => res, flushHeaders: () => undefined, write: () => true, on: () => res };
    dispatcher.respond("GET", "commands", "", res as unknown as http.ServerResponse);
    dispatcher.respond("GET", "commands", "", res as unknown as http.ServerResponse);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("Opus 5.5");
    expect(said).toEqual([]);
  });
});

describe("voice command timing (#448)", () => {
  function timeline() {
    const lines: string[] = [];
    let now = 0;
    const clock = { set: (ms: number) => void (now = ms) };
    return { lines, clock, timeline: new VoiceTimeline((line) => lines.push(line), () => now) };
  }

  it("logs each stage from the key-up to the first sound, once per command", () => {
    const { lines, clock, timeline: t } = timeline();
    for (const [ms, stage] of [[0, "key-up"], [700, "transcript"], [710, "sent"], [3_200, "answer"], [3_900, "audio"], [9_000, "audio"]] as const) {
      clock.set(ms);
      t.mark(stage);
    }
    expect(lines).toEqual([
      "[assistant-timing] key-up→transcript 0.70s",
      "[assistant-timing] transcript→sent 0.01s",
      "[assistant-timing] sent→answer 2.49s",
      "[assistant-timing] answer→audio 0.70s, key-up→audio 3.90s"
    ]);
  });

  it("times a command without a key from its transcript, and ignores a dictation's old key-up", () => {
    const { lines, clock, timeline: t } = timeline();
    t.mark("key-up");
    clock.set(60_000);
    t.mark("transcript");
    clock.set(61_000);
    t.mark("answer");
    clock.set(62_000);
    t.mark("transcript");
    clock.set(62_500);
    t.mark("audio");
    expect(lines).toEqual(["[assistant-timing] transcript→answer 1.00s", "[assistant-timing] transcript→audio 0.50s"]);
  });
});
