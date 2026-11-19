import { describe, expect, it } from "vitest";

import { sendTaskToSession, taskMessage, tasksFromNotesJson } from "../desktop/meeting/meeting-tasks.ts";
import type { ReplyDeps } from "../desktop/claude-code/reply.ts";
import type { ClaudeSession } from "../desktop/claude-code/registry.ts";

const CALL = { title: "Sprint sync", startedAt: "2026-11-19T09:00:00.000Z", language: "en" as const };

const session = (status: ClaudeSession["status"]): ClaudeSession => ({
  pid: 1,
  sessionId: "s",
  name: "marshal",
  cwd: "/x",
  status,
  waitingFor: null,
  entrypoint: "cli",
  socketPath: "/tmp/x.sock",
  startedAt: 0,
  statusUpdatedAt: null
});

describe("tasksFromNotesJson", () => {
  it("keeps valid tasks and drops empty or malformed ones", () => {
    const raw = JSON.stringify({
      tasks: [
        { task: "Write the spec", owner: " Ivan ", mine: false },
        { task: "  ", owner: null, mine: true },
        "junk",
        { task: "Ship it", owner: null, mine: true }
      ]
    });
    expect(tasksFromNotesJson(raw)).toEqual([
      { task: "Write the spec", owner: "Ivan", mine: false },
      { task: "Ship it", owner: null, mine: true }
    ]);
    expect(tasksFromNotesJson("not json")).toEqual([]);
  });
});

describe("taskMessage", () => {
  it("adds the call title and date as context", () => {
    expect(taskMessage({ task: "Write the spec", owner: null, mine: true }, CALL)).toBe(
      'Write the spec\n\nAction item from the call "Sprint sync" (2026-11-19).'
    );
  });
});

describe("sendTaskToSession", () => {
  const deps = (): ReplyDeps & { typed: string[] } => {
    const typed: string[] = [];
    return {
      typed,
      hostApp: async () => "/Applications/Terminal.app",
      focusSession: async () => "tab",
      probe: async () => ({ isTextInput: true, frontmostPath: "/Applications/Terminal.app" }) as never,
      writeClipboard: () => undefined,
      sendKey: async (key) => {
        typed.push(key);
      },
      activate: async () => undefined
    };
  };

  it("refuses a busy or missing session without typing anything", async () => {
    const d = deps();
    expect(await sendTaskToSession(session("busy"), "marshal", "x", d)).toContain("busy");
    expect(await sendTaskToSession(undefined, "ghost", "x", d)).toContain("No live session");
    expect(d.typed).toEqual([]);
  });
});
