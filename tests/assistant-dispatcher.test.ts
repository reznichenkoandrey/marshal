import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantCommandQueue, MAX_QUEUED_COMMANDS, QUEUED_COMMAND_TTL_MS } from "../desktop/assistant/command-queue.ts";
import { AssistantDispatcher, type DispatcherDeps } from "../desktop/assistant/dispatcher.ts";
import {
  briefSessions,
  buildHelperScript,
  dispatcherCommandLine,
  findProject,
  generalCommandLine,
  isValidSessionName,
  parseHelperArgs,
  sessionsForDispatcher,
  spawnProjects,
  terminalScript,
  withTrustedFolder
} from "../desktop/assistant/dispatcher-files.ts";
import { ClaudeHookService, rejectHookRequest } from "../desktop/claude-code/hook-service.ts";
import { SessionNotifier, type SpokenSessionEvent } from "../desktop/claude-code/session-notifier.ts";
import type { ClaudeSession } from "../desktop/claude-code/registry.ts";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-dispatcher-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function session(overrides: Partial<ClaudeSession>): ClaudeSession {
  return {
    pid: 1, sessionId: "s", name: "s", cwd: "/p", status: "idle", waitingFor: null,
    entrypoint: "cli", socketPath: "/tmp/s.sock", startedAt: 0, statusUpdatedAt: null,
    ...overrides
  };
}

describe("command queue", () => {
  it("delivers to a listening dispatcher, holds commands while none listens", () => {
    let now = 1_000;
    const queue = new AssistantCommandQueue(() => now);
    expect(queue.submit("перший")).toBe(false);
    expect(queue.submit("другий", "marshal")).toBe(false);
    expect(queue.listening).toBe(false);

    const lines: string[] = [];
    const sink = { write: (line: string) => lines.push(line) };
    queue.connect(sink);
    expect(queue.listening).toBe(true);
    const sent = lines.map((line) => JSON.parse(line) as { id: string; text: string; target?: string });
    expect(sent.map((c) => c.text)).toEqual(["перший", "другий"]);
    expect(sent[1].target).toBe("marshal");
    // Same millisecond, distinct ids.
    expect(sent[0].id).not.toBe(sent[1].id);

    now += 1;
    expect(queue.submit("третій")).toBe(true);
    expect(lines).toHaveLength(3);
    queue.disconnect(sink);
    expect(queue.listening).toBe(false);
  });

  it("drops stale and excess commands, sends to the newest stream only", () => {
    let now = 0;
    const queue = new AssistantCommandQueue(() => now);
    queue.submit("old");
    now = QUEUED_COMMAND_TTL_MS + 1;
    for (let i = 0; i < MAX_QUEUED_COMMANDS + 5; i += 1) queue.submit(`c${i}`);
    const first: string[] = [];
    const second: string[] = [];
    queue.connect({ write: (line) => first.push(line) });
    expect(first).toHaveLength(MAX_QUEUED_COMMANDS);
    expect(first.join("")).not.toContain("\"old\"");

    queue.connect({ write: (line) => second.push(line) });
    queue.submit("once");
    expect(second).toHaveLength(1);
    expect(first).toHaveLength(MAX_QUEUED_COMMANDS);
  });
});

describe("dispatcher files", () => {
  it("lets the assistant routes through only when they are set", () => {
    const req = { method: "GET", url: "/assistant/sessions", host: "127.0.0.1:4000", origin: undefined, authorization: "Bearer t" };
    expect(rejectHookRequest(req, 4000, "t")).toBe(404);
    expect(rejectHookRequest(req, 4000, "t", true)).toBeNull();
    expect(rejectHookRequest({ ...req, method: "DELETE" }, 4000, "t", true)).toBe(404);
    expect(rejectHookRequest({ ...req, origin: "https://evil.example" }, 4000, "t", true)).toBe(403);
    expect(rejectHookRequest({ ...req, authorization: "Bearer x" }, 4000, "t", true)).toBe(401);
  });

  it("lists sessions for the dispatcher without itself, newest first, with socket addresses", () => {
    const live = [
      session({ name: "old", cwd: "/a/old", startedAt: 1, socketPath: "/s/old" }),
      session({ name: "marshal-dispatcher", cwd: "/data/assistant/dispatcher/", startedAt: 9 }),
      session({ name: "new", cwd: "/a/new", startedAt: 2, statusUpdatedAt: 5, status: "waiting", waitingFor: "permission prompt", socketPath: "/s/new" })
    ];
    expect(sessionsForDispatcher(live, "/data/assistant/dispatcher")).toEqual([
      { name: "new", folder: "new", status: "waiting", waitingFor: "permission prompt", address: "uds:/s/new" },
      { name: "old", folder: "old", status: "idle", waitingFor: null, address: "uds:/s/old" }
    ]);
  });

  it("finds spawn projects by folder name, general first, live folders before roots", () => {
    const projects = spawnProjects(
      [session({ cwd: "/work/Funky-Rabbit" })],
      ["/htdocs/funky-rabbit", "/htdocs/marshal", "/htdocs/general"],
      "/data/assistant/general"
    );
    expect([...projects.keys()]).toEqual(["general", "funky-rabbit", "marshal"]);
    expect(findProject(projects, " Funky Rabbit ")).toBe("/work/Funky-Rabbit");
    expect(findProject(projects, "general")).toBe("/data/assistant/general");
    expect(findProject(projects, "snoriq")).toBeNull();
  });

  it("marks a folder trusted once and keeps the rest of ~/.claude.json", () => {
    const state = { numStartups: 3, projects: { "/x": { allowedTools: ["Bash"] } } };
    const next = withTrustedFolder(state, "/x/");
    expect(next).toEqual({ numStartups: 3, projects: { "/x": { allowedTools: ["Bash"], hasTrustDialogAccepted: true } } });
    expect(withTrustedFolder(next!, "/x")).toBeNull();
    expect(withTrustedFolder({}, "/y")).toEqual({ projects: { "/y": { hasTrustDialogAccepted: true } } });
  });

  it("quotes paths and titles for the shell and for AppleScript", () => {
    const script = terminalScript("/Users/me/it's \"here\"", "claude --name 'x'", "it's");
    expect(script).toContain("do script \"printf '\\\\033]0;%s\\\\007' 'it'\\\\''s'; cd '/Users/me/it'\\\\''s \\\"here\\\"' && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL claude --name 'x'\"");
    expect(script).toContain("set miniaturized of front window to true");
    expect(dispatcherCommandLine("")).toBe("claude --name marshal-dispatcher --no-chrome --model 'haiku' --setting-sources project 'Start the monitor and wait for commands.'");
    expect(generalCommandLine("/a b/p.md", "auto")).toBe("claude --name general --no-chrome --permission-mode auto --append-system-prompt \"$(cat '/a b/p.md')\"");
    expect(generalCommandLine("/p.md", "default")).not.toContain("--permission-mode");
  });

  it("validates session names and parses helper arguments", () => {
    expect(isValidSessionName("фіча-1494_b")).toBe(true);
    expect(isValidSessionName("a b")).toBe(false);
    expect(isValidSessionName("x;rm")).toBe(false);
    expect(isValidSessionName("x".repeat(41))).toBe(false);
    expect(parseHelperArgs("marshal\n feature 1 \n\n")).toEqual(["marshal", "feature 1"]);
  });

  it("briefs who waits and who works in the owner's language", () => {
    const live = [session({ name: "a", status: "waiting" }), session({ name: "b", status: "busy" }), session({ name: "c", status: "idle" })];
    expect(briefSessions(live, "uk")).toBe("Чекають на тебе: a. Працюють: b.");
    expect(briefSessions([session({ name: "c" })], "en")).toBe("All 1 sessions are idle.");
    expect(briefSessions([], "uk")).toBe("Сесій Claude Code немає.");
  });
});

describe("dispatcher over the hook receiver", () => {
  function setup(live: ClaudeSession[]) {
    const userDataDir = tmpDir();
    const hookDir = path.join(userDataDir, "claude-code");
    const said: string[] = [];
    const actions: string[] = [];
    const scripts: string[] = [];
    const deps: DispatcherDeps = {
      userDataDir,
      hookDir: () => hookDir,
      settings: () => ({ model: "haiku", generalDir: "", generalMode: "auto", routingRoots: [] }),
      liveSessions: () => live,
      context: async () => "off",
      say: (text) => said.push(text),
      runAction: async (action) => {
        actions.push(action);
        return `ran ${action}`;
      },
      announce: () => undefined,
      focus: () => undefined,
      runAppleScript: async (script) => {
        scripts.push(script);
      },
      claudeStatePath: path.join(userDataDir, ".claude.json")
    };
    const dispatcher = new AssistantDispatcher(deps);
    const service = new ClaudeHookService(hookDir, () => undefined);
    service.setAssistantRoutes(dispatcher);
    return { dispatcher, service, said, actions, scripts, hookDir };
  }

  const helper = (hookDir: string, args: string[]) => new Promise<string>((resolve, reject) => {
    const file = path.join(path.dirname(hookDir), "helper.sh");
    fs.writeFileSync(file, buildHelperScript(hookDir), { mode: 0o700 });
    execFile("/bin/sh", [file, ...args], (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

  it("answers the real helper script: sessions, say with quotes, do", async () => {
    const live = [session({ name: "marshal", cwd: "/htdocs/marshal", socketPath: "/s/m" })];
    const { service, said, actions, hookDir } = setup(live);
    await service.start();
    try {
      const sessions = JSON.parse(await helper(hookDir, ["sessions"])) as { address: string }[];
      expect(sessions.map((s) => s.address)).toEqual(["uds:/s/m"]);
      expect(await helper(hookDir, ["say", "Передав \"marshal\"; $(rm -rf /)"])).toBe("ok\n");
      expect(said).toEqual(["Передав \"marshal\"; $(rm -rf /)"]);
      expect(await helper(hookDir, ["do", "brief"])).toBe("ran brief\n");
      expect(actions).toEqual(["brief"]);
    } finally {
      service.stop();
    }
  });

  it("streams a queued command to the watcher and a live one after it", async () => {
    const { dispatcher, service, hookDir } = setup([]);
    dispatcher.submit("відкрий перекладач");
    await service.start();
    const port = fs.readFileSync(path.join(hookDir, "port"), "utf8").trim();
    const auth = fs.readFileSync(path.join(hookDir, "auth-header"), "utf8").trim().replace(/^Authorization: /, "");
    const lines: string[] = [];
    const req = http.get({ host: "127.0.0.1", port, path: "/assistant/commands", headers: { Authorization: auth } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => lines.push(...chunk.split("\n").filter(Boolean)));
    });
    try {
      await vi.waitFor(() => expect(lines).toHaveLength(1));
      expect(dispatcher.listening).toBe(true);
      dispatcher.submit("скажи marshal запусти тести");
      await vi.waitFor(() => expect(lines).toHaveLength(2));
      expect(lines.map((line) => (JSON.parse(line) as { text: string }).text)).toEqual(["відкрий перекладач", "скажи marshal запусти тести"]);
    } finally {
      req.destroy();
      service.stop();
    }
  });

  it("opens the dispatcher and general once, in minimised Terminal windows", async () => {
    const { dispatcher, scripts } = setup([]);
    await dispatcher.start();
    await dispatcher.start();
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain("--name marshal-dispatcher");
    expect(scripts[1]).toContain("--name general");
    expect(fs.readFileSync(path.join(dispatcher.dispatcherDir, "CLAUDE.md"), "utf8")).toContain("./marshal watch");
    expect(fs.statSync(path.join(dispatcher.dispatcherDir, "marshal")).mode & 0o777).toBe(0o700);
    const trusted = JSON.parse(fs.readFileSync(path.join(path.dirname(dispatcher.dispatcherDir), "..", ".claude.json"), "utf8")) as { projects: Record<string, unknown> };
    expect(Object.keys(trusted.projects)).toEqual([dispatcher.dispatcherDir, dispatcher.generalDir()]);
  });
});

describe("spoken session events", () => {
  it("speaks a finished summary and a waiting prompt", async () => {
    const spoken: SpokenSessionEvent[] = [];
    const notifier = new SessionNotifier({
      notify: () => undefined,
      speak: (event) => spoken.push(event),
      summarize: async () => "Тести пройшли.",
      findSession: () => session({ sessionId: "s1", name: "marshal" }),
      focus: () => undefined,
      setTimer: () => 1 as unknown as NodeJS.Timeout,
      clearTimer: () => undefined
    });
    await notifier.handle({ type: "stop", sessionId: "s1", cwd: "/p", lastMessage: "line one\nline two" });
    await notifier.handle({ type: "attention", sessionId: "s1", cwd: "/p", reason: "confirmation", message: "Allow Bash?" });
    expect(spoken).toEqual([
      { kind: "finished", name: "marshal", summary: "Тести пройшли." },
      { kind: "waiting", name: "marshal", confirmation: true }
    ]);
  });
});
