import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OUTPUT_SCHEMA } from "../desktop/workflows/contract.ts";
import { validateDefinition, type WorkflowDefinition } from "../desktop/workflows/definition.ts";
import { runProcess, claudeArgs, workflowEnv, type RunOutcome } from "../desktop/workflows/runner.ts";
import { decideDue, localDay, takeDailyRun, WorkflowScheduler } from "../desktop/workflows/scheduler.ts";
import { emptyState, JOURNAL_MAX_BYTES, WorkflowStore } from "../desktop/workflows/store.ts";

const KYIV = "Europe/Kyiv";
// 10:00 in Kyiv.
const NOW = Date.parse("2026-11-22T08:00:00Z");
const MINUTE = 60_000;
const dirs: string[] = [];
const QUIET: RunOutcome = { status: "ok", result: { say: "", silent: true, memory: null, charts: 0 } };

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflows-"));
  dirs.push(dir);
  return dir;
}

function definition(patch: Record<string, unknown> = {}): WorkflowDefinition {
  const result = validateDefinition({ id: "wf", name: "Hourly", schedule: { cron: "0 * * * *", timezone: KYIV }, prompt: "Report.", ...patch });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.definition;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("decideDue", () => {
  it("runs a late run once within 30 minutes and drops an older one", () => {
    expect(decideDue("once", NOW, NOW + 29 * MINUTE)).toBe("run");
    expect(decideDue("once", NOW, NOW + 31 * MINUTE)).toBe("slept");
  });

  it("with skip runs only on time", () => {
    expect(decideDue("skip", NOW, NOW + 500)).toBe("run");
    expect(decideDue("skip", NOW, NOW + 5 * MINUTE)).toBe("slept");
  });
});

describe("takeDailyRun", () => {
  it("counts runs per local day and stops at the cap", () => {
    const state = emptyState();
    expect(takeDailyRun(state, "2026-11-22", 2)).toBe(true);
    expect(takeDailyRun(state, "2026-11-22", 2)).toBe(true);
    expect(takeDailyRun(state, "2026-11-22", 2)).toBe(false);
    expect(takeDailyRun(state, "2026-11-23", 2)).toBe(true);
    expect(state.runsCount).toBe(1);
  });

  it("takes the day from the workflow's zone", () => {
    expect(localDay(Date.parse("2026-11-22T22:30:00Z"), KYIV)).toBe("2026-11-23");
    expect(localDay(Date.parse("2026-11-22T22:30:00Z"), "America/New_York")).toBe("2026-11-22");
  });
});

describe("WorkflowStore", () => {
  it("writes definitions atomically and reads them back", () => {
    const dir = tempDir();
    const store = new WorkflowStore(dir);
    store.saveDefinitions([definition()]);
    expect(fs.readdirSync(dir)).toEqual(["definitions.json"]);
    expect(store.loadDefinitions(NOW)).toEqual([definition()]);
  });

  it("moves a corrupt file aside instead of erasing it", () => {
    const dir = tempDir();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, "definitions.json"), "{ not json");
    const store = new WorkflowStore(dir);
    expect(store.loadDefinitions(NOW)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([`definitions.json.corrupt-${NOW}`]);
    expect(fs.readFileSync(path.join(dir, `definitions.json.corrupt-${NOW}`), "utf8")).toBe("{ not json");
  });

  it("skips invalid and duplicate entries but keeps the valid ones", () => {
    const dir = tempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = definition();
    fs.writeFileSync(
      path.join(dir, "definitions.json"),
      JSON.stringify({ schemaVersion: 1, workflows: [good, { ...good, id: "bad", writes: true }, good] })
    );
    expect(new WorkflowStore(dir).loadDefinitions(NOW)).toEqual([good]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(dir)).toEqual(["definitions.json"]);
  });

  it("ignores a file of another schema version", () => {
    const dir = tempDir();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, "definitions.json"), JSON.stringify({ schemaVersion: 2, workflows: [definition()] }));
    expect(new WorkflowStore(dir).loadDefinitions(NOW)).toEqual([]);
  });

  it("returns nothing when there is no file", () => {
    const store = new WorkflowStore(tempDir());
    expect(store.loadDefinitions(NOW)).toEqual([]);
    expect(store.loadState(NOW).size).toBe(0);
    expect(store.readRuns("wf")).toEqual([]);
  });

  it("appends journal lines, trims the error and rotates a full journal", () => {
    const dir = tempDir();
    const store = new WorkflowStore(dir);
    store.appendRun("wf", { at: NOW, status: "failed", reason: "exit", error: "x".repeat(900) });
    store.appendRun("wf", { at: NOW + 1, status: "ok", durationMs: 5 });
    const runs = store.readRuns("wf");
    expect(runs).toHaveLength(2);
    expect(runs[0].error).toHaveLength(500);

    fs.appendFileSync(path.join(dir, "runs", "wf.ndjson"), " ".repeat(JOURNAL_MAX_BYTES));
    store.appendRun("wf", { at: NOW + 2, status: "ok" });
    expect(store.readRuns("wf")).toEqual([{ at: NOW + 2, status: "ok" }]);
    expect(fs.readdirSync(path.join(dir, "runs")).sort()).toEqual(["wf.1.ndjson", "wf.ndjson"]);
  });

  it("drops memory when the prompt or the tool list changed", () => {
    const store = new WorkflowStore(tempDir());
    const first = definition({ allowedTools: ["Read"] });
    store.writeMemory(first, { seen: [1, 2] });
    expect(store.readMemory(first, NOW)).toEqual({ seen: [1, 2] });
    expect(store.readMemory(definition({ allowedTools: ["Read"], name: "Renamed", timeoutMs: 20_000 }), NOW)).toEqual({ seen: [1, 2] });
    expect(store.readMemory(definition({ allowedTools: ["Read"], prompt: "Other." }), NOW)).toBeNull();
    expect(store.readMemory(definition({ allowedTools: ["Read", "Grep"] }), NOW)).toBeNull();
  });
});

describe("WorkflowScheduler", () => {
  let dir: string;
  let store: WorkflowStore;
  let runs: string[];
  let finish: Array<(outcome: RunOutcome) => void>;
  const run = (def: WorkflowDefinition): Promise<RunOutcome> => {
    runs.push(def.id);
    return new Promise((resolve) => finish.push(resolve));
  };
  const reasons = (id = "wf"): Array<string | undefined> => store.readRuns(id).map((record) => record.reason ?? record.status);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 10 * MINUTE);
    dir = tempDir();
    store = new WorkflowStore(dir);
    runs = [];
    finish = [];
  });

  it("schedules nothing while no workflow is enabled", () => {
    const empty = new WorkflowScheduler(store, run);
    empty.start();
    expect(empty.hasTimer()).toBe(false);

    store.saveDefinitions([definition({ enabled: false })]);
    const disabled = new WorkflowScheduler(store, run);
    disabled.start();
    expect(disabled.hasTimer()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms one timer to the nearest run and re-arms after it fires", async () => {
    store.saveDefinitions([definition(), definition({ id: "daily", schedule: { cron: "0 9 * * *", timezone: KYIV } })]);
    const scheduler = new WorkflowScheduler(store, run);
    scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    expect(runs).toEqual([]);

    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(runs).toEqual(["wf"]);
    expect(vi.getTimerCount()).toBe(1);
    finish[0](QUIET);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.readRuns("wf")).toEqual([{ at: NOW + 60 * MINUTE, status: "ok", durationMs: 0, say: "", silent: true, charts: 0 }]);
    expect(store.loadState(NOW).get("wf")?.nextRunAt).toBe(NOW + 120 * MINUTE);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-arms daily for a run further away than a timer can reach", async () => {
    store.saveDefinitions([definition({ schedule: { cron: "0 9 1 1 *", timezone: KYIV } })]);
    const scheduler = new WorkflowScheduler(store, run);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(3 * 86_400_000);
    expect(runs).toEqual([]);
    expect(scheduler.hasTimer()).toBe(true);
    scheduler.stop();
  });

  it("after a short sleep runs a missed hourly workflow once", () => {
    store.saveDefinitions([definition()]);
    const scheduler = new WorkflowScheduler(store, run);
    scheduler.start();
    // Asleep through 11:00; awake at 11:20.
    vi.setSystemTime(NOW + 80 * MINUTE);
    scheduler.rearm();
    expect(runs).toEqual(["wf"]);
    expect(store.loadState(NOW).get("wf")?.nextRunAt).toBe(NOW + 120 * MINUTE);
    scheduler.stop();
  });

  it("after a long sleep merges the missed runs into one skipped record", () => {
    store.saveDefinitions([definition()]);
    const scheduler = new WorkflowScheduler(store, run);
    scheduler.start();
    // Asleep through 11:00, 12:00 and 13:00; awake at 13:40.
    vi.setSystemTime(NOW + 220 * MINUTE);
    scheduler.rearm();
    expect(runs).toEqual([]);
    expect(reasons()).toEqual(["slept"]);
    expect(store.loadState(NOW).get("wf")?.nextRunAt).toBe(NOW + 240 * MINUTE);
    scheduler.stop();
  });

  it("does not run a daily workflow late, but runs it on time", async () => {
    store.saveDefinitions([definition({ schedule: { cron: "0 11 * * *", timezone: KYIV } })]);
    const late = new WorkflowScheduler(store, run);
    late.start();
    vi.setSystemTime(NOW + 70 * MINUTE);
    late.rearm();
    expect(runs).toEqual([]);
    expect(reasons()).toEqual(["slept"]);
    late.stop();

    await vi.advanceTimersByTimeAsync(86_400_000 - 10 * MINUTE);
    const onTime = new WorkflowScheduler(store, run);
    onTime.start();
    expect(runs).toEqual(["wf"]);
    onTime.stop();
  });

  it("applies the same policy to runs missed while the app was closed", () => {
    store.saveDefinitions([definition()]);
    const first = new WorkflowScheduler(store, run);
    first.start();
    first.stop();

    vi.setSystemTime(NOW + 75 * MINUTE);
    const second = new WorkflowScheduler(store, run);
    second.start();
    expect(runs).toEqual(["wf"]);
    second.stop();
  });

  it("runs a runAtStart workflow on start only", () => {
    store.saveDefinitions([definition({ runAtStart: true })]);
    const scheduler = new WorkflowScheduler(store, run);
    scheduler.start();
    expect(runs).toEqual(["wf"]);
    scheduler.rearm();
    expect(runs).toEqual(["wf"]);
    scheduler.stop();
  });

  it("skips a run while the previous one is still going", async () => {
    store.saveDefinitions([definition()]);
    const scheduler = new WorkflowScheduler(store, run);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(runs).toEqual(["wf"]);
    expect(reasons()).toEqual(["overlap"]);
    finish[0](QUIET);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(runs).toEqual(["wf", "wf"]);
    scheduler.stop();
  });

  it("stops at maxRunsPerDay until the next local day", async () => {
    store.saveDefinitions([definition({ maxRunsPerDay: 2 })]);
    const scheduler = new WorkflowScheduler(store, async (def) => {
      runs.push(def.id);
      return QUIET;
    });
    scheduler.start();
    // 11:00, 12:00, 13:00 Kyiv.
    await vi.advanceTimersByTimeAsync(180 * MINUTE);
    expect(runs).toHaveLength(2);
    expect(reasons()).toEqual(["ok", "ok", "daily-cap"]);
    // Through midnight in Kyiv: 14:00 to 23:00 are capped, 00:00 runs.
    await vi.advanceTimersByTimeAsync(11 * 60 * MINUTE);
    expect(runs).toHaveLength(3);
    scheduler.stop();
  });

  it("pauses a workflow after three failed runs in a row, each retried once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.saveDefinitions([definition()]);
    const scheduler = new WorkflowScheduler(store, async (def) => {
      runs.push(def.id);
      return { status: "failed", reason: "timeout" };
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * MINUTE);
    expect(runs).toHaveLength(6);
    expect(reasons()).toEqual(Array(6).fill("timeout"));
    expect(store.loadState(NOW).get("wf")?.failures).toBe(3);
    expect(store.loadState(NOW).get("wf")?.paused).toBe("failing");
    expect(scheduler.hasTimer()).toBe(false);

    // Disabling and enabling again clears the pause.
    store.saveDefinitions([definition({ enabled: false })]);
    scheduler.rearm();
    store.saveDefinitions([definition()]);
    scheduler.rearm();
    expect(scheduler.hasTimer()).toBe(true);
    scheduler.stop();
  });

  it("records a run that throws as failed", async () => {
    store.saveDefinitions([definition()]);
    const scheduler = new WorkflowScheduler(store, () => Promise.reject(new Error("boom")));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(store.readRuns("wf")[0]).toMatchObject({ status: "failed", reason: "exit", error: "boom" });
    scheduler.stop();
  });

  it("recomputes the next run when the schedule changed", () => {
    store.saveDefinitions([definition()]);
    const scheduler = new WorkflowScheduler(store, run);
    scheduler.start();
    store.saveDefinitions([definition({ schedule: { cron: "30 * * * *", timezone: KYIV } })]);
    scheduler.rearm();
    expect(store.loadState(NOW).get("wf")?.nextRunAt).toBe(NOW + 30 * MINUTE);
    scheduler.stop();
  });

  it("forgets the state of a removed workflow", () => {
    store.saveDefinitions([definition()]);
    const scheduler = new WorkflowScheduler(store, run);
    scheduler.start();
    store.saveDefinitions([]);
    scheduler.rearm();
    expect(store.loadState(NOW).size).toBe(0);
    expect(scheduler.hasTimer()).toBe(false);
  });
});

describe("runner", () => {
  const options = { input: "hello", env: process.env, timeoutMs: 5_000 };

  it("passes the prompt on stdin and returns the output", async () => {
    expect(await runProcess("cat", [], options)).toEqual({ status: "ok", output: "hello" });
  });

  it("reports a non-zero exit with the last stderr line", async () => {
    expect(await runProcess("sh", ["-c", "echo one >&2; echo two >&2; exit 3"], options)).toEqual({ status: "failed", reason: "exit", error: "two" });
  });

  it("reports empty output and a missing binary", async () => {
    expect(await runProcess("true", [], options)).toEqual({ status: "failed", reason: "empty" });
    expect(await runProcess("/nonexistent/claude", [], options)).toMatchObject({ status: "failed", reason: "missing-binary" });
  });

  it("kills a run at the timeout, with SIGKILL when SIGTERM is ignored", async () => {
    expect(await runProcess("sleep", ["30"], { ...options, timeoutMs: 100 })).toEqual({ status: "failed", reason: "timeout" });
    const started = Date.now();
    const stubborn = await runProcess("sh", ["-c", "trap '' TERM; while :; do sleep 0.05; done"], { ...options, timeoutMs: 100, killGraceMs: 200 });
    expect(stubborn).toEqual({ status: "failed", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("builds a dontAsk command limited to the allowed tools", () => {
    expect(claudeArgs(definition({ allowedTools: ["Read", "mcp__github__list_issues"], mcpServers: ["github"] }))).toEqual([
      "-p", "--output-format", "json", "--json-schema", JSON.stringify(OUTPUT_SCHEMA), "--model", "haiku", "--permission-mode", "dontAsk", "--allowedTools", "Read", "mcp__github__list_issues"
    ]);
    expect(claudeArgs(definition())).not.toContain("--allowedTools");
  });

  it("strips API keys and the host session from the environment", () => {
    const env = workflowEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "u", CLAUDE_CODE_CHILD_SESSION: "1" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});
