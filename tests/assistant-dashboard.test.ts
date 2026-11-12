// Home dashboard data (#398): the voice command log, feature cards and the
// per-role memory split.

import { describe, expect, it } from "vitest";

import {
  COMMAND_LOG_LIMIT,
  NO_ANSWER_MS,
  answerFromSession,
  appendCommand,
  commandCounts,
  commandRows,
  parseCommandLog,
  routeCommand,
  type CommandEntry
} from "../desktop/assistant/command-log.ts";
import { featureCards, formatLatency, modelLabel, type FeatureInputs } from "../desktop/assistant/features.ts";
import { footprintGroup, groupFootprint } from "../desktop/perf/footprint.ts";

const T0 = new Date(2026, 10, 12, 15, 0, 0).getTime();

describe("command log", () => {
  it("routes the newest pending command and keeps the duration for final outcomes", () => {
    let log = appendCommand([], "translate this", T0);
    log = routeCommand(log, { kind: "feature", target: "translator", outcome: "answered" }, T0 + 1500);
    const [row] = commandRows(log, T0 + 2000);
    expect(row).toMatchObject({ target: "translator", kind: "feature", outcome: "answered", durationMs: 1500 });
  });

  it("marks a sent command answered when that session finishes", () => {
    let log = appendCommand([], "run tests in marshal", T0);
    log = routeCommand(log, { kind: "session", target: "marshal", outcome: "sent" }, T0 + 1000);
    expect(commandRows(log, T0 + 2000)[0]).toMatchObject({ outcome: "sent", durationMs: null });
    log = answerFromSession(log, "other", T0 + 3000);
    expect(log[0]?.outcome).toBe("sent");
    log = answerFromSession(log, "marshal", T0 + 61_000);
    expect(commandRows(log, T0 + 62_000)[0]).toMatchObject({ outcome: "answered", durationMs: 61_000 });
  });

  it("leaves resolved commands alone and calls a stale pending one unanswered", () => {
    let log = appendCommand([], "first", T0);
    log = routeCommand(log, { kind: "general", target: "marshal", outcome: "answered" }, T0 + 100);
    const again = routeCommand(log, { kind: "feature", target: "captions", outcome: "failed" }, T0 + 200);
    expect(again).toEqual(log);
    log = appendCommand(log, "second", T0 + 1000);
    expect(commandRows(log, T0 + 1000 + NO_ANSWER_MS)[0]?.outcome).toBe("no_answer");
  });

  it("keeps a ring of the newest entries", () => {
    let log: CommandEntry[] = [];
    for (let index = 0; index < COMMAND_LOG_LIMIT + 5; index += 1) log = appendCommand(log, `c${index}`, T0 + index);
    expect(log).toHaveLength(COMMAND_LOG_LIMIT);
    expect(log[0]?.text).toBe("c5");
    expect(commandRows(log, T0, 3).map((row) => row.text)).toEqual([`c${COMMAND_LOG_LIMIT + 4}`, `c${COMMAND_LOG_LIMIT + 3}`, `c${COMMAND_LOG_LIMIT + 2}`]);
  });

  it("counts today against yesterday and the week against the week before", () => {
    const day = 24 * 60 * 60_000;
    let log: CommandEntry[] = [];
    for (const at of [T0 - 10 * day, T0 - 8 * day, T0 - 1 * day, T0 - 1 * day, T0 - 1000, T0]) log = appendCommand(log, "x", at);
    expect(commandCounts(log, T0, 1)).toEqual({ current: 2, previous: 2 });
    expect(commandCounts(log, T0, 7)).toEqual({ current: 4, previous: 2 });
  });

  it("survives a broken file", () => {
    expect(parseCommandLog("{not json")).toEqual([]);
    expect(parseCommandLog('[{"id":1,"text":"a","at":1},{"bad":true}]')).toHaveLength(1);
  });
});

const READY: FeatureInputs = {
  dictation: { enabled: true, modelPath: "/m/ggml-large-v3-turbo-q8_0.bin", resident: true, active: false, backend: "hybrid" },
  captions: { running: false, stt: "auto" },
  translator: { available: true, backend: "claude-cli", open: false, lastLatencyMs: 820, lastFailed: false },
  speech: { enabled: true, speaking: false, engine: "macos", engineInstalled: true },
  calendar: { enabled: true, configured: true, lastError: null, lastSyncAt: "2026-11-12T14:00:00.000Z" }
};

describe("feature cards", () => {
  it("reports every feature ready with its stats", () => {
    const cards = featureCards(READY);
    expect(cards.map((card) => card.state)).toEqual(["ready", "ready", "ready", "ready", "ready"]);
    expect(cards[0]?.stats).toEqual(["large-v3-turbo-q8_0", "resident"]);
    expect(cards[2]?.stats).toEqual(["claude-cli", "820ms"]);
  });

  it("maps off, missing models, running and errors", () => {
    const cards = featureCards({
      dictation: { ...READY.dictation, modelPath: null, backend: "whisper-cpp" },
      captions: { running: true, stt: "groq" },
      translator: { ...READY.translator, lastFailed: true },
      speech: { ...READY.speech, engine: "holos", engineInstalled: false },
      calendar: { ...READY.calendar, configured: false }
    });
    expect(cards.map((card) => card.state)).toEqual(["no_model", "running", "error", "no_model", "off"]);
    expect(featureCards({ ...READY, dictation: { ...READY.dictation, modelPath: null, backend: "groq" } })[0]?.state).toBe("ready");
    expect(featureCards({ ...READY, calendar: { ...READY.calendar, lastError: "HTTP 404" } })[4]?.state).toBe("error");
    expect(featureCards({ ...READY, speech: { ...READY.speech, enabled: false } })[3]?.state).toBe("off");
  });

  it("formats the model and latency", () => {
    expect(modelLabel("/x/ggml-small.bin")).toBe("small");
    expect(formatLatency(null)).toBe("–");
    expect(formatLatency(1840)).toBe("1.8s");
  });
});

describe("memory split", () => {
  it("groups processes by role and leaves the speech model out", () => {
    expect(footprintGroup("Marshal Helper (Renderer)")).toBe("renderer");
    expect(footprintGroup("Electron Helper (GPU)")).toBe("gpu");
    expect(footprintGroup("Marshal Helper")).toBe("service");
    expect(footprintGroup("Electron")).toBe("main");
    expect(footprintGroup("ptt-monitor")).toBe("helpers");
    const mb = 1024 ** 2;
    expect(
      groupFootprint([
        { pid: 1, name: "Marshal", bytes: 70 * mb },
        { pid: 2, name: "Marshal Helper (Renderer)", bytes: 29 * mb },
        { pid: 3, name: "Marshal Helper (Renderer)", bytes: 26 * mb },
        { pid: 4, name: "ptt-monitor", bytes: 8 * mb },
        { pid: 5, name: "whisper-server", bytes: 1000 * mb }
      ])
    ).toEqual([
      { group: "main", mb: 70 },
      { group: "renderer", mb: 55 },
      { group: "helpers", mb: 8 }
    ]);
  });
});
