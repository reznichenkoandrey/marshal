// Scheduler for local workflows (#280): one timer re-armed to the nearest run,
// nothing scheduled while no workflow is enabled (#281).

import type { RunResult } from "./contract.ts";
import { nextRunAt, parseCron, wallClock } from "./cron.ts";
import type { WorkflowDefinition } from "./definition.ts";
import type { FailureReason, RunOutcome } from "./runner.ts";
import { emptyState, type WorkflowState, type WorkflowStore } from "./store.ts";

export const CATCH_UP_WINDOW_MS = 30 * 60_000;
// A timer that fires a little late is still on time, not a missed run.
export const ON_TIME_MS = 60_000;
export const MAX_FAILURES = 3;
export const RETRY_DELAY_MS = 2 * 60_000;
// setTimeout overflows past ~24.8 days; a far run is reached by re-arming daily.
export const MAX_TIMER_MS = 86_400_000;

export type DueDecision = "run" | "slept";
export type RunNowResult = "started" | "overlap" | "daily-cap" | "unknown";

export type WorkflowEvent =
  | { kind: "result"; definition: WorkflowDefinition; result: RunResult }
  | { kind: "failed"; definition: WorkflowDefinition; reason: FailureReason; error?: string; paused: WorkflowState["paused"] };

/** What to do with a run whose time has passed: late within the policy runs once, later is dropped. */
export function decideDue(catchUp: WorkflowDefinition["catchUp"], scheduledAt: number, now: number): DueDecision {
  const lag = now - scheduledAt;
  return lag <= (catchUp === "once" ? CATCH_UP_WINDOW_MS : ON_TIME_MS) ? "run" : "slept";
}

/** Calendar date in the workflow's zone, the unit `maxRunsPerDay` counts in. */
export function localDay(instant: number, timeZone: string): string {
  return new Date(wallClock(instant, timeZone)).toISOString().slice(0, 10);
}

/** Counts one more run for today; false when the daily cap is already used up. */
export function takeDailyRun(state: WorkflowState, day: string, maxRunsPerDay: number): boolean {
  if (state.runsDay !== day) {
    state.runsDay = day;
    state.runsCount = 0;
  }
  if (state.runsCount >= maxRunsPerDay) return false;
  state.runsCount += 1;
  return true;
}

/** A failed run is retried once, unless waiting cannot help. */
export function shouldRetry(reason: FailureReason, isRetry: boolean): boolean {
  return !isRetry && reason !== "auth" && reason !== "missing-binary";
}

function scheduleKey(definition: WorkflowDefinition): string {
  return `${definition.schedule.cron}|${definition.schedule.timezone}`;
}

export class WorkflowScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private states: Map<string, WorkflowState>;
  private readonly running = new Set<string>();

  constructor(
    private readonly store: WorkflowStore,
    private readonly run: (definition: WorkflowDefinition) => Promise<RunOutcome>,
    private readonly now: () => number = Date.now,
    private readonly onEvent: (event: WorkflowEvent) => void = () => {}
  ) {
    this.states = store.loadState(this.now());
  }

  /** App start counts as a wake: missed runs follow `catchUp`, `runAtStart` workflows run now. */
  start(): void {
    this.rearm(true);
  }

  /** Re-reads the definitions, handles runs that are due and sets the single timer. */
  rearm(startup = false): void {
    const now = this.now();
    const definitions = this.store.loadDefinitions(now);
    const live = new Set(definitions.map((definition) => definition.id));
    for (const id of this.states.keys()) {
      if (!live.has(id)) this.states.delete(id);
    }

    let nearest: number | null = null;
    for (const definition of definitions) {
      if (!definition.enabled) {
        // Re-enabling starts clean: no missed run and no pause carried over.
        // The day's run count stays, so manual runs cannot outrun the cap.
        const state = this.states.get(definition.id);
        if (state) Object.assign(state, { ...emptyState(), runsDay: state.runsDay, runsCount: state.runsCount });
        continue;
      }
      const state = this.stateOf(definition.id);
      if (state.paused) continue;

      const rule = parseCron(definition.schedule.cron);
      if (!rule) continue;
      const next = (after: number): number | null => nextRunAt(rule, definition.schedule.timezone, after);
      const key = scheduleKey(definition);
      // A slot computed for another rule says nothing about this one.
      if (state.schedule !== key) state.nextRunAt = null;
      state.schedule = key;

      if (startup && definition.runAtStart) state.nextRunAt = now;
      if (state.nextRunAt === null) state.nextRunAt = next(now);
      if (state.nextRunAt !== null && state.nextRunAt <= now) {
        const scheduledAt = state.nextRunAt;
        state.nextRunAt = next(now);
        // The scheduled run replaces a retry that is still pending.
        state.retryAt = null;
        if (decideDue(definition.catchUp, scheduledAt, now) === "slept") this.skip(definition.id, now, "slept");
        else this.launch(definition, state, now, false);
      } else if (state.retryAt !== null && state.retryAt <= now) {
        state.retryAt = null;
        this.launch(definition, state, now, true);
      }
      for (const at of [state.nextRunAt, state.retryAt]) {
        if (!state.paused && at !== null && (nearest === null || at < nearest)) nearest = at;
      }
    }
    this.store.saveState(this.states);

    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (nearest !== null) {
      this.timer = setTimeout(() => this.rearm(), Math.min(Math.max(nearest - now, 0), MAX_TIMER_MS));
      this.timer.unref?.();
    }
  }

  /** Runs an enabled or disabled workflow right now, outside its schedule; overlap and the daily cap still apply. */
  runNow(id: string): RunNowResult {
    const now = this.now();
    const definition = this.store.loadDefinitions(now).find((candidate) => candidate.id === id);
    if (!definition) return "unknown";
    const launched = this.launch(definition, this.stateOf(id), now, true);
    this.store.saveState(this.states);
    return launched;
  }

  /** Forgets failures and the pause of one workflow; the next rearm schedules it afresh. */
  unpause(id: string): void {
    this.states.delete(id);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  hasTimer(): boolean {
    return this.timer !== null;
  }

  private stateOf(id: string): WorkflowState {
    const state = this.states.get(id) ?? emptyState();
    this.states.set(id, state);
    return state;
  }

  private skip(id: string, now: number, reason: string): void {
    this.store.appendRun(id, { at: now, status: "skipped", reason });
  }

  private launch(definition: WorkflowDefinition, state: WorkflowState, now: number, isRetry: boolean): Exclude<RunNowResult, "unknown"> {
    if (this.running.has(definition.id)) {
      this.skip(definition.id, now, "overlap");
      return "overlap";
    }
    if (!takeDailyRun(state, localDay(now, definition.schedule.timezone), definition.maxRunsPerDay)) {
      this.skip(definition.id, now, "daily-cap");
      return "daily-cap";
    }

    this.running.add(definition.id);
    void this.run(definition)
      .catch((err: unknown): RunOutcome => ({ status: "failed", reason: "exit", error: err instanceof Error ? err.message : String(err) }))
      .then((outcome) => {
        this.running.delete(definition.id);
        const durationMs = this.now() - now;
        const current = this.states.get(definition.id) === state;
        if (outcome.status === "ok") {
          state.failures = 0;
          // A run that works again ends the pause (a manual run after logging in).
          state.paused = null;
          const { say, silent, charts } = outcome.result;
          this.store.appendRun(definition.id, { at: now, status: "ok", durationMs, say, silent, charts });
          this.onEvent({ kind: "result", definition, result: outcome.result });
        } else {
          this.store.appendRun(definition.id, { at: now, status: "failed", reason: outcome.reason, durationMs, error: outcome.error });
          if (current && shouldRetry(outcome.reason, isRetry)) {
            state.retryAt = this.now() + RETRY_DELAY_MS;
          } else {
            state.failures += 1;
            if (outcome.reason === "auth") state.paused = "auth";
            else if (state.failures >= MAX_FAILURES) state.paused = "failing";
            this.onEvent({ kind: "failed", definition, reason: outcome.reason, error: outcome.error, paused: state.paused });
          }
        }
        // Skipped when the workflow was removed or disabled while it ran.
        if (current) this.rearm();
      });
    return "started";
  }
}
