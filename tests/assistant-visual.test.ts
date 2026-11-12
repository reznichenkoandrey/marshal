// tests/assistant-visual.test.ts
import { describe, expect, it } from "vitest";

import { deriveAssistantState, groupSessions, IDLE_INPUTS, projectOf, pushLine, sessionCounts } from "../desktop/assistant/assistant-state.ts";
import type { ClaudeSession } from "../desktop/claude-code/registry.ts";
import {
  ambientLevel,
  frameIntervalMs,
  mixRgb,
  normalizeState,
  parseRgb,
  STATE_STYLE,
  STATES,
  stateLabel,
  stepParams,
  targetParams
} from "../desktop/renderer/assistant-visual.js";

describe("deriveAssistantState", () => {
  it("is idle with nothing going on", () => {
    expect(deriveAssistantState(IDLE_INPUTS)).toBe("idle");
  });

  it("puts the user's own speech above anything sessions do", () => {
    expect(deriveAssistantState({ ...IDLE_INPUTS, dictating: true, waitingSessions: 2, busySessions: 3 })).toBe("listening");
    expect(deriveAssistantState({ ...IDLE_INPUTS, transcribing: true, waitingSessions: 1 })).toBe("thinking");
    expect(deriveAssistantState({ ...IDLE_INPUTS, speaking: true, busySessions: 1 })).toBe("speaking");
  });

  it("ranks a waiting session above a busy one: only it needs the user", () => {
    expect(deriveAssistantState({ ...IDLE_INPUTS, busySessions: 3, waitingSessions: 1 })).toBe("waiting");
    expect(deriveAssistantState({ ...IDLE_INPUTS, busySessions: 1 })).toBe("working");
  });

  it("shows offline only when nothing else is happening", () => {
    expect(deriveAssistantState({ ...IDLE_INPUTS, offline: true })).toBe("offline");
    expect(deriveAssistantState({ ...IDLE_INPUTS, offline: true, busySessions: 1 })).toBe("working");
  });

  it("sleeps over sessions, but not over the owner's own speech", () => {
    expect(deriveAssistantState({ ...IDLE_INPUTS, asleep: true, waitingSessions: 1 })).toBe("sleeping");
    expect(deriveAssistantState({ ...IDLE_INPUTS, asleep: true, dictating: true })).toBe("listening");
    expect(deriveAssistantState({ ...IDLE_INPUTS, asleep: true, speaking: true })).toBe("speaking");
  });
});

describe("state styles", () => {
  it("covers every state with a design token, never a raw colour", () => {
    for (const state of STATES) {
      expect(STATE_STYLE[state].color).toMatch(/^--state-/);
    }
  });

  it("labels every state in Ukrainian and English", () => {
    for (const state of STATES) {
      expect(stateLabel(state, "uk")).not.toBe("");
      expect(stateLabel(state, "en")).not.toBe("");
    }
    expect(stateLabel("listening", "uk")).toBe("Слухаю");
    expect(stateLabel("waiting", "en")).toBe("Needs you");
  });

  it("falls back to idle and English on unknown input", () => {
    expect(normalizeState("dancing")).toBe("idle");
    expect(stateLabel("listening", "de")).toBe("Listening");
  });
});

describe("stepParams", () => {
  it("does not move on a zero step and converges over time", () => {
    const from = targetParams("idle");
    const to = targetParams("thinking");
    expect(stepParams(from, to, 0)).toEqual(from);

    let current = from;
    for (let i = 0; i < 120; i++) current = stepParams(current, to, 1 / 60);
    expect(current.spin).toBeCloseTo(to.spin, 2);
    expect(current.scan).toBeCloseTo(to.scan, 2);
  });

  it("is frame-rate independent: one 100 ms step equals six 16.7 ms steps", () => {
    const from = targetParams("idle");
    const to = targetParams("listening");
    let small = from;
    for (let i = 0; i < 6; i++) small = stepParams(small, to, 0.1 / 6);
    const big = stepParams(from, to, 0.1);
    expect(small.glow).toBeCloseTo(big.glow, 6);
  });

  it("moves part of the way, never past the target", () => {
    const from = targetParams("idle");
    const to = targetParams("thinking");
    const next = stepParams(from, to, 1 / 60);
    expect(next.spin).toBeGreaterThan(from.spin);
    expect(next.spin).toBeLessThan(to.spin);
  });
});

describe("colours", () => {
  it("parses rgb() and the color(srgb …) form Chromium gives color-mix()", () => {
    expect(parseRgb("rgb(77, 195, 255)")).toEqual([77, 195, 255]);
    expect(parseRgb("rgba(77, 195, 255, 0.3)")).toEqual([77, 195, 255]);
    expect(parseRgb("color(srgb 0 0.5 1 / 0.3)")).toEqual([0, 127.5, 255]);
    expect(parseRgb("light-dark(red, blue)")).toBeNull();
  });

  it("mixes linearly and clamps the amount", () => {
    expect(mixRgb([0, 0, 0], [100, 200, 50], 0.5)).toEqual([50, 100, 25]);
    expect(mixRgb([0, 0, 0], [100, 200, 50], 2)).toEqual([100, 200, 50]);
  });
});

describe("ambientLevel", () => {
  it("stays within 0..1 for every state", () => {
    for (const state of STATES) {
      for (let t = 0; t < 10; t += 0.37) {
        for (const noise of [0, 1]) {
          const level = ambientLevel(state, t, noise);
          expect(level).toBeGreaterThanOrEqual(0);
          expect(level).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("is louder while listening than while idle", () => {
    let listening = 0;
    let idle = 0;
    for (let t = 0; t < 10; t += 0.1) {
      listening += ambientLevel("listening", t, 0.5);
      idle += ambientLevel("idle", t, 0.5);
    }
    expect(listening).toBeGreaterThan(idle * 3);
  });
});

describe("frameIntervalMs", () => {
  it("caps at 30 fps on power and 20 on battery", () => {
    expect(frameIntervalMs(false)).toBeCloseTo(33.3, 1);
    expect(frameIntervalMs(true)).toBe(50);
  });
});

describe("assistant sessions panel (#308)", () => {
  const session = (pid: number, name: string, cwd: string, status: ClaudeSession["status"], waitingFor: string | null = null): ClaudeSession => ({
    pid, sessionId: `s${pid}`, name, cwd, status, waitingFor,
    entrypoint: "cli", socketPath: "", startedAt: 0, statusUpdatedAt: null
  });

  it("names a worktree session after the repository, not the worktree", () => {
    expect(projectOf("/Users/me/htdocs/marshal/.claude/worktrees/dictate-7fa531")).toBe("marshal");
    expect(projectOf("/Users/me/htdocs/marshal")).toBe("marshal");
  });

  it("puts projects with a waiting session first and orders sessions by status", () => {
    const groups = groupSessions([
      session(1, "docs", "/w/alpha", "idle"),
      session(2, "api", "/w/beta", "busy"),
      session(3, "fix", "/w/alpha/.claude/worktrees/fix-1", "waiting", "permission prompt"),
      session(4, "build", "/w/alpha", "busy")
    ]);
    expect(groups.map((group) => group.project)).toEqual(["alpha", "beta"]);
    expect(groups[0].sessions.map((view) => view.name)).toEqual(["fix", "build", "docs"]);
    expect(groups[0].sessions[0]).toEqual({ pid: 3, name: "fix", status: "waiting", waitingFor: "permission prompt" });
  });

  it("counts busy and waiting sessions for the state hub", () => {
    expect(sessionCounts([{ status: "busy" }, { status: "waiting" }, { status: "busy" }, { status: null }]))
      .toEqual({ busySessions: 2, waitingSessions: 1 });
  });

  it("keeps the last five lines, newest first, without stacking a repeat", () => {
    let lines: string[] = [];
    for (const text of ["a", "b", "b", "  c \n d ", "", "e", "f", "g"]) lines = pushLine(lines, text);
    expect(lines).toEqual(["g", "f", "e", "c d", "b"]);
  });
});
