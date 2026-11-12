import { describe, expect, it } from "vitest";

import type { FocusProbeResult } from "../desktop/dictation/focus-paste.ts";
import type { ClaudeSession } from "../desktop/claude-code/registry.ts";
import { mayPressReturn, replyToSession, type ReplyDeps } from "../desktop/claude-code/reply.ts";

const focus = (overrides: Partial<FocusProbeResult>): FocusProbeResult => ({
  isTextInput: true, role: "AXTextArea", subrole: "", axError: 0, axTrusted: true, frontmostApp: "Terminal", ...overrides
});

const session: ClaudeSession = {
  pid: 7, sessionId: "f", name: "funky-rabbit", cwd: "/p", status: "idle", waitingFor: null,
  entrypoint: "cli", socketPath: "/tmp/f.sock", startedAt: 0, statusUpdatedAt: null
};

function deps(probes: FocusProbeResult[], shown: "tab" | "session" | "app" | null = "tab") {
  const calls: string[] = [];
  const replyDeps: ReplyDeps = {
    hostApp: async () => "Terminal",
    focusSession: async () => shown,
    probe: async () => probes.shift() ?? focus({}),
    writeClipboard: (text) => calls.push(`clipboard ${text}`),
    sendKey: async (key) => {
      calls.push(`key ${key}`);
    },
    activate: async (app) => {
      calls.push(`activate ${app}`);
    }
  };
  return { replyDeps, calls };
}

describe("mayPressReturn", () => {
  it("needs the session's host in front with a text field focused", () => {
    expect(mayPressReturn(focus({}), "Terminal")).toBe(true);
    expect(mayPressReturn(focus({ frontmostApp: "iTerm2" }), "iTerm")).toBe(true);
    expect(mayPressReturn(focus({ frontmostApp: "Slack" }), "Terminal")).toBe(false);
    expect(mayPressReturn(focus({ isTextInput: false }), "Terminal")).toBe(false);
    expect(mayPressReturn(focus({ isTextInput: false, axError: -25204, role: "" }), "Terminal")).toBe(false);
    expect(mayPressReturn(focus({}), "")).toBe(false);
  });
});

describe("replyToSession", () => {
  it("pastes, presses Return and brings back the owner's app", async () => {
    const { replyDeps, calls } = deps([focus({ frontmostApp: "Slack" }), focus({})]);
    expect(await replyToSession(session, "так, архівуй", replyDeps)).toBe("ok");
    expect(calls).toEqual(["clipboard так, архівуй", "key v", "key return", "activate Slack"]);
  });

  it("leaves the words on the clipboard when the input field is not focused", async () => {
    const { replyDeps, calls } = deps([focus({ frontmostApp: "Slack" }), focus({ frontmostApp: "Slack" })]);
    expect(await replyToSession(session, "так", replyDeps)).toContain("on the clipboard");
    expect(calls).toEqual(["clipboard так"]);
  });

  it("never types when only the host app came forward", async () => {
    const { replyDeps, calls } = deps([focus({}), focus({})], "app");
    expect(await replyToSession(session, "так", replyDeps)).toContain("on the clipboard");
    expect(calls).toEqual(["clipboard так"]);
  });
});
