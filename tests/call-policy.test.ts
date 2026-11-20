import { describe, expect, it } from "vitest";

import { SessionNotifier } from "../desktop/claude-code/session-notifier.ts";
import { CallMonitor, INITIAL_CALL_STATE, nextCallState, shouldHoldNotification } from "../desktop/presence/call-policy.ts";

describe("shouldHoldNotification", () => {
  it("holds finished results only while on a call", () => {
    expect(shouldHoldNotification(false, true)).toBe(true);
    expect(shouldHoldNotification(false, false)).toBe(false);
  });

  it("never holds urgent notices, even on a call", () => {
    expect(shouldHoldNotification(true, true)).toBe(false);
  });
});

describe("nextCallState", () => {
  it("offers recording once when a call starts with nothing recording", () => {
    const first = nextCallState(INITIAL_CALL_STATE, true, false);
    expect(first.offer).toBe(true);
    const second = nextCallState(first.state, true, false);
    expect(second.offer).toBe(false);
  });

  it("does not offer while a recording already runs", () => {
    expect(nextCallState(INITIAL_CALL_STATE, true, true).offer).toBe(false);
  });

  it("re-arms the offer only after the call ends", () => {
    const during = nextCallState(INITIAL_CALL_STATE, true, false);
    const ended = nextCallState(during.state, false, false);
    expect(ended.state).toEqual(INITIAL_CALL_STATE);
    expect(nextCallState(ended.state, true, false).offer).toBe(true);
  });
});

describe("CallMonitor", () => {
  it("calls offer once per call on the edge", async () => {
    let onCall = true;
    let offers = 0;
    const monitor = new CallMonitor(async () => onCall, () => false, () => offers++);
    expect(await monitor.check()).toBe(true);
    await monitor.check();
    expect(offers).toBe(1);
    onCall = false;
    await monitor.check();
    onCall = true;
    await monitor.check();
    expect(offers).toBe(2);
  });
});

describe("SessionNotifier held results", () => {
  const stop = { type: "stop" as const, sessionId: "s1", cwd: "/tmp/alpha", lastMessage: "Tests pass." };

  function harness(initialOnCall: boolean) {
    const shown: Array<{ title: string; body: string }> = [];
    const timers: Array<() => void> = [];
    let onCall = initialOnCall;
    const notifier = new SessionNotifier({
      notify: (title, body) => shown.push({ title, body }),
      summarize: async () => null,
      findSession: () => undefined,
      focus: () => {},
      onCall: async () => onCall,
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length as unknown as NodeJS.Timeout;
      },
      clearTimer: () => {}
    });
    return { notifier, shown, timers, setCall: (value: boolean) => (onCall = value) };
  }

  it("holds a finished result during a call and releases a digest after it ends", async () => {
    const { notifier, shown, timers, setCall } = harness(true);
    await notifier.handle(stop);
    await notifier.handle({ ...stop, sessionId: "s2", cwd: "/tmp/beta" });
    expect(shown).toHaveLength(0);
    expect(timers).toHaveLength(1);

    setCall(false);
    timers[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.body).toContain("alpha");
    expect(shown[0]?.body).toContain("beta");
  });

  it("shows a result immediately when no call is active", async () => {
    const { notifier, shown } = harness(false);
    await notifier.handle(stop);
    expect(shown).toHaveLength(1);
  });
});
