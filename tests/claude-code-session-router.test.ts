import { describe, expect, it, vi } from "vitest";

import type { ClaudeSession } from "../desktop/claude-code/registry.ts";
import {
  isCancelled,
  matchSessionPrefix,
  parseShortAnswer,
  planDelivery,
  SessionCommandRouter,
  sessionAliases,
  tokensMatch,
  transliterate
} from "../desktop/claude-code/session-router.ts";
import type { ContextRouter } from "../desktop/claude-code/context-router.ts";

function session(over: Partial<ClaudeSession> & { sessionId: string }): ClaudeSession {
  return {
    pid: 100,
    name: over.sessionId,
    cwd: `/Users/me/htdocs/${over.sessionId}`,
    status: "idle",
    waitingFor: null,
    entrypoint: "cli",
    socketPath: "/tmp/s",
    startedAt: 0,
    statusUpdatedAt: null,
    ...over
  };
}

const feature = session({ sessionId: "a", name: "feature-1494", cwd: "/Users/me/htdocs/marshal" });
const vasia = session({ sessionId: "b", name: "Вася", cwd: "/Users/me/htdocs/snoriq" });
const worktree = session({
  sessionId: "c",
  name: "dictate-to-session-7fa531",
  cwd: "/Users/me/htdocs/marshal/.claude/worktrees/dictate-to-session-7fa531"
});
const sessions = [feature, vasia, worktree];

describe("transliteration and token matching", () => {
  it("maps Ukrainian letters to Latin", () => {
    expect(transliterate("Вася")).toBe("vasia");
    expect(transliterate("Щука")).toBe("shchuka");
  });

  it("tolerates Ukrainian inflection and STT spelling of a name", () => {
    for (const spoken of ["vasia", "vasi", "vasiu", "vaseiu", "vasya"]) {
      expect(tokensMatch(spoken, "vasia")).toBe(true);
    }
    expect(tokensMatch("vlad", "vasia")).toBe(false);
    expect(tokensMatch("feature", "fix")).toBe(false);
  });

  it("compares numbers exactly", () => {
    expect(tokensMatch("1494", "1494")).toBe(true);
    expect(tokensMatch("1495", "1494")).toBe(false);
  });
});

describe("sessionAliases", () => {
  it("adds the folder and drops the worktree hash suffix", () => {
    expect(sessionAliases(worktree)).toEqual(["dictate-to-session-7fa531", "dictate-to-session"]);
    expect(sessionAliases(feature)).toEqual(["feature-1494", "marshal"]);
  });
});

describe("matchSessionPrefix", () => {
  it("matches an English name and strips it from the command", () => {
    expect(matchSessionPrefix("Feature 1494, run the tests.", sessions)).toEqual({
      sessions: [feature],
      rest: "run the tests."
    });
  });

  it("matches a Ukrainian loanword spelling of a Latin name", () => {
    expect(matchSessionPrefix("Фіча 1494, запусти тести", sessions)).toEqual({ sessions: [feature], rest: "запусти тести" });
    expect(matchSessionPrefix("фічі 1494 запусти тести", sessions)?.sessions).toEqual([feature]);
  });

  it("joins digit groups whisper splits", () => {
    expect(matchSessionPrefix("feature 1,494: run the tests", sessions)?.rest).toBe("run the tests");
    expect(matchSessionPrefix("feature1494 run the tests", sessions)?.sessions).toEqual([feature]);
  });

  it("matches an inflected Cyrillic alias and its Latin spelling", () => {
    expect(matchSessionPrefix("Васю, перевір білд", sessions)).toEqual({ sessions: [vasia], rest: "перевір білд" });
    expect(matchSessionPrefix("Vasya check the build", sessions)?.rest).toBe("check the build");
  });

  it("matches the folder alias and the worktree name without its hash", () => {
    expect(matchSessionPrefix("Snoriq: deploy", sessions)?.sessions).toEqual([vasia]);
    expect(matchSessionPrefix("dictate to session, commit", sessions)).toEqual({ sessions: [worktree], rest: "commit" });
  });

  it("skips a leading «сесія» / session", () => {
    expect(matchSessionPrefix("Сесія Вася, перевір білд", sessions)?.sessions).toEqual([vasia]);
    expect(matchSessionPrefix("session feature 1494 run it", sessions)?.rest).toBe("run it");
  });

  it("prefers the longer alias and reports a tie as ambiguous", () => {
    const other = session({ sessionId: "d", name: "feature-1500", cwd: "/Users/me/htdocs/marshal" });
    expect(matchSessionPrefix("feature 1494 go", [feature, other])?.sessions).toEqual([feature]);
    expect(matchSessionPrefix("marshal, run tests", [feature, other])?.sessions).toEqual([feature, other]);
  });

  it("returns null when the transcript does not start with a name", () => {
    expect(matchSessionPrefix("run the tests", sessions)).toBeNull();
    expect(matchSessionPrefix("запусти тести для фічі 1494", sessions)).toBeNull();
  });
});

describe("control words", () => {
  it("drops a command that ends in cancel", () => {
    expect(isCancelled("фіча 1494, запусти тести, скасуй")).toBe(true);
    expect(isCancelled("run the tests. Cancel.")).toBe(true);
    expect(isCancelled("never mind")).toBe(true);
    expect(isCancelled("cancel the old job and run tests")).toBe(false);
  });

  it("parses short answers in both languages", () => {
    expect(parseShortAnswer("Так.")).toEqual({ kind: "yes" });
    expect(parseShortAnswer("do it")).toEqual({ kind: "yes" });
    expect(parseShortAnswer("Ні")).toEqual({ kind: "no" });
    expect(parseShortAnswer("Другий варіант")).toEqual({ kind: "option", n: 2 });
    expect(parseShortAnswer("option two")).toEqual({ kind: "option", n: 2 });
    expect(parseShortAnswer("варіант 3")).toEqual({ kind: "option", n: 3 });
    expect(parseShortAnswer("run the tests")).toBeNull();
    expect(parseShortAnswer("так, але спершу запусти тести")).toBeNull();
  });
});

describe("planDelivery", () => {
  const permission = { status: "waiting" as const, waitingFor: "permission prompt" };

  it("answers a permission prompt with single keys only", () => {
    expect(planDelivery("так", permission)).toEqual({ kind: "key", key: "1" });
    expect(planDelivery("option two", permission)).toEqual({ kind: "key", key: "2" });
    expect(planDelivery("no", permission)).toEqual({ kind: "key", key: "escape" });
    expect(planDelivery("run the tests", permission).kind).toBe("blocked");
  });

  it("types text into an idle session", () => {
    expect(planDelivery("run the tests", { status: "idle", waitingFor: null })).toEqual({ kind: "text", text: "run the tests" });
    expect(planDelivery("так", { status: "idle", waitingFor: null })).toEqual({ kind: "text", text: "так" });
  });

  it("picks an option in other waiting prompts by number", () => {
    expect(planDelivery("другий варіант", { status: "waiting", waitingFor: "input needed" })).toEqual({ kind: "key", key: "2" });
  });
});

describe("SessionCommandRouter", () => {
  it("cancels, and reports when nothing is running", async () => {
    const router = new SessionCommandRouter();
    expect(await router.route("feature 1494 run tests, скасуй", sessions)).toEqual({ kind: "cancelled" });
    expect(await router.route("run tests", [])).toEqual({ kind: "no-sessions" });
  });

  it("sends a named command and opens the picker on ambiguity", async () => {
    const router = new SessionCommandRouter();
    expect(await router.route("feature 1494, run tests", sessions)).toEqual({ kind: "send", session: feature, command: "run tests" });
    const twin = session({ sessionId: "e", name: "Вася", cwd: "/x/other" });
    expect(await router.route("Васю, run tests", [vasia, twin])).toEqual({
      kind: "pick",
      candidates: [vasia, twin],
      command: "run tests"
    });
    expect(await router.route("Вася", sessions)).toEqual({ kind: "empty", session: vasia });
  });

  it("sends an unnamed answer to the one waiting session, or asks between several", async () => {
    const router = new SessionCommandRouter();
    const waiting = { ...vasia, status: "waiting" as const, waitingFor: "permission prompt" };
    expect(await router.route("другий варіант", [feature, waiting])).toEqual({ kind: "send", session: waiting, command: "другий варіант" });
    const waiting2 = { ...feature, status: "waiting" as const };
    expect((await router.route("yes", [waiting2, waiting])).kind).toBe("pick");
  });

  it("asks the context router only when nothing is named or waiting", async () => {
    const contextRouter: ContextRouter = { route: vi.fn(async () => ({ kind: "session" as const, sessionId: "b" })) };
    const router = new SessionCommandRouter(contextRouter);
    expect(await router.route("feature 1494 go", sessions)).toMatchObject({ session: feature });
    expect(contextRouter.route).not.toHaveBeenCalled();
    expect(await router.route("check the build", sessions)).toEqual({
      kind: "send",
      session: vasia,
      command: "check the build",
      byContext: true
    });
    expect(contextRouter.route).toHaveBeenCalledWith("check the build", sessions);
  });

  it("does not flag the only live session as routed by context", async () => {
    const router = new SessionCommandRouter({ route: async () => ({ kind: "session", sessionId: "b" }) });
    expect(await router.route("check the build", [vasia])).toEqual({ kind: "send", session: vasia, command: "check the build" });
  });

  it("opens the picker with the context router's candidates when it is unsure", async () => {
    const router = new SessionCommandRouter({ route: async () => ({ kind: "unsure", candidates: ["a", "c", "gone"] }) });
    expect(await router.route("check the build", sessions)).toEqual({
      kind: "pick",
      candidates: [feature, worktree],
      command: "check the build"
    });
  });

  it("falls back to the last session sent to when context routing is off or fails", async () => {
    for (const contextRouter of [
      undefined,
      { route: async () => ({ kind: "off" as const }) },
      { route: async () => Promise.reject(new Error("boom")) }
    ]) {
      const router = new SessionCommandRouter(contextRouter);
      expect((await router.route("check the build", sessions)).kind).toBe("pick");
      router.remember("c");
      expect(await router.route("check the build", sessions)).toEqual({ kind: "send", session: worktree, command: "check the build" });
    }
  });

  it("sends to the only live session without asking", async () => {
    expect(await new SessionCommandRouter().route("check the build", [vasia])).toEqual({
      kind: "send",
      session: vasia,
      command: "check the build"
    });
  });
});
