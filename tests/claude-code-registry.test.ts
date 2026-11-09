import { describe, expect, it } from "vitest";

import { describeStatus, listLiveSessions, parseSessionFile } from "../desktop/claude-code/registry.ts";
import { findFocusTarget, parseProcessTable, terminalTabScript } from "../desktop/claude-code/focus.ts";

// Shape copied from a real ~/.claude/sessions file written by Claude Code 2.1.317.
const desktopSession = {
  pid: 15142,
  sessionId: "8a44c875-4ca4-4e2c-ae1c-db6bb44b2e23",
  cwd: "/Users/me/htdocs/cpap",
  startedAt: 1794061768635,
  procStart: "Sat Nov  7 14:29:25 2026",
  version: "2.1.317",
  peerProtocol: 1,
  peerFeatures: ["notify_idle"],
  kind: "interactive",
  entrypoint: "claude-desktop",
  hostSessionId: "local_6081acd0",
  pidDomain: "darwin",
  messagingSocketPath: "/tmp/cc-socks/15142.sock",
  name: "Порівняння даних CPAP сайтів",
  nameSource: "user",
  status: "idle",
  updatedAt: 1794062407401,
  statusUpdatedAt: 1794062407401
};

const file = (overrides: Record<string, unknown>) => JSON.stringify({ ...desktopSession, ...overrides });

describe("parseSessionFile", () => {
  it("reads name, folder, status and socket from a live interactive session", () => {
    expect(parseSessionFile("15142.json", file({}))).toEqual({
      pid: 15142,
      sessionId: "8a44c875-4ca4-4e2c-ae1c-db6bb44b2e23",
      name: "Порівняння даних CPAP сайтів",
      cwd: "/Users/me/htdocs/cpap",
      status: "idle",
      waitingFor: null,
      entrypoint: "claude-desktop",
      socketPath: "/tmp/cc-socks/15142.sock",
      startedAt: 1794061768635,
      statusUpdatedAt: 1794062407401
    });
  });

  it("keeps what a waiting session is blocked on", () => {
    const session = parseSessionFile("15142.json", file({ status: "waiting", waitingFor: "permission prompt" }));
    expect(session?.status).toBe("waiting");
    expect(describeStatus(session!)).toBe("waiting: permission prompt");
  });

  it("skips background jobs and daemons that share the directory", () => {
    for (const kind of ["bg", "daemon", "daemon-worker", undefined]) {
      expect(parseSessionFile("15142.json", file({ kind }))).toBeNull();
    }
  });

  it("skips non-canonical names, a pid that disagrees with the name, and broken JSON", () => {
    expect(parseSessionFile("15142.tmp.json", file({}))).toBeNull();
    expect(parseSessionFile("15142.json", file({ pid: 999 }))).toBeNull();
    expect(parseSessionFile("15142.json", "{\"pid\":")).toBeNull();
    expect(parseSessionFile("15142.json", file({ messagingSocketPath: undefined }))).toBeNull();
  });

  it("falls back to the folder name and an unknown status instead of failing", () => {
    const session = parseSessionFile("15142.json", file({ name: undefined, status: "thinking" }));
    expect(session?.name).toBe("cpap");
    expect(session?.status).toBeNull();
    expect(describeStatus(session!)).toBe("live");
  });
});

describe("listLiveSessions", () => {
  const files: Record<string, string> = {
    "/s/1.json": file({ pid: 1, messagingSocketPath: "/sock/1", statusUpdatedAt: 10 }),
    "/s/2.json": file({ pid: 2, messagingSocketPath: "/sock/2", statusUpdatedAt: 30 }),
    "/s/3.json": file({ pid: 3, messagingSocketPath: "/sock/3" }),
    "/s/4.json": file({ pid: 4, messagingSocketPath: "/sock/4" }),
    "/s/5.json": file({ pid: 5, kind: "bg", messagingSocketPath: "/sock/5" }),
    "/s/6.json": "not json",
    "/s/1.abc.key": "secret"
  };
  const warnings: string[] = [];
  const list = () =>
    listLiveSessions({
      dir: "/s",
      readDir: () => Object.keys(files).map((p) => p.slice(3)),
      readFile: (p) => files[p],
      isAlive: (pid) => pid !== 3,
      exists: (p) => p !== "/sock/4",
      warn: (m) => warnings.push(m)
    });

  it("keeps only sessions whose process is alive and socket exists, newest first", () => {
    expect(list().map((s) => s.pid)).toEqual([2, 1]);
  });

  it("reports unreadable files but not known foreign kinds", () => {
    warnings.length = 0;
    list();
    expect(warnings).toEqual(["1 session file(s) in /s did not match the expected format"]);
  });

  it("returns an empty list when the directory is missing", () => {
    expect(listLiveSessions({ dir: "/nope", readDir: () => { throw new Error("ENOENT"); } })).toEqual([]);
  });
});

describe("focus target", () => {
  const table = parseProcessTable([
    "    1     0 ??       /sbin/launchd",
    "71085     1 ??       /Applications/Claude.app/Contents/MacOS/Claude",
    "15141 71085 ??       /Applications/Claude.app/Contents/Helpers/disclaimer",
    "15142 15141 ??       /Users/me/Library/Application Support/Claude/claude-code/2.1.317/x/claude.app/Contents/MacOS/claude",
    "  500     1 ??       /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    "  501   500 ttys003  login",
    "  502   501 ttys003  -zsh",
    "  503   502 ttys003  claude"
  ].join("\n"));

  it("finds the hosting app for a desktop session, skipping the claude.app of the binary itself", () => {
    expect(findFocusTarget(table, 15142)).toEqual({ tty: null, appPath: "/Applications/Claude.app" });
  });

  it("finds the tty and the terminal for a CLI session", () => {
    expect(findFocusTarget(table, 503)).toEqual({
      tty: "ttys003",
      appPath: "/System/Applications/Utilities/Terminal.app"
    });
  });

  it("scripts a tab switch only for Terminal and iTerm, and only for a real tty", () => {
    expect(terminalTabScript("/System/Applications/Utilities/Terminal.app", "ttys003")).toContain('tty of t is "/dev/ttys003"');
    expect(terminalTabScript("/Applications/iTerm.app", "ttys003")).toContain('tty of s is "/dev/ttys003"');
    expect(terminalTabScript("/Applications/Visual Studio Code.app", "ttys003")).toBeNull();
    expect(terminalTabScript("/Applications/iTerm.app", "ttys003\" & do shell script \"x")).toBeNull();
  });
});
