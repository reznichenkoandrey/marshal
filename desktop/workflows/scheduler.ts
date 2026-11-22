// Scheduler for local workflows (#280): one timer re-armed to the nearest run,
// nothing scheduled while no workflow is enabled (#281).

import { nextRunAt, parseCron, wallClock } from "./cron.ts";
import type { WorkflowDefinition } from "./definition.ts";
import type { RunOutcome } from "./runner.ts";
import { emptyState, type WorkflowState, type WorkflowStore } from "./store.ts";

export const CATCH_UP_WINDOW_MS = 30 * 60_000;
// A timer that fires a little late is still on time, not a missed run.
export const ON_TIME_MS = 60_000;
export const MAX_FAILURES = 3;
// setTimeout overflows past ~24.8 days; a far run is reached by re-arming daily.
export const MAX_TIMER_MS = 86_400_000;

export type DueDecision = "run" | "slept";

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
    private readonly now: () => number = Date.now
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
        this.states.delete(definition.id);
        continue;
      }
      const state = this.states.get(definition.id) ?? emptyState();
      this.states.set(definition.id, state);
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
        this.handleDue(definition, state, scheduledAt, now);
      }
      if (!state.paused && state.nextRunAt !== null && (nearest === null || state.nextRunAt < nearest)) nearest = state.nextRunAt;
    }
    this.store.saveState(this.states);

    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (nearest !== null) {
      this.timer = setTimeout(() => this.rearm(), Math.min(Math.max(nearest - now, 0), MAX_TIMER_MS));
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  hasTimer(): boolean {
    return this.timer !== null;
  }

  private handleDue(definition: WorkflowDefinition, state: WorkflowState, scheduledAt: number, now: number): void {
    const skip = (reason: string): void => this.store.appendRun(definition.id, { at: now, status: "skipped", reason });
    if (decideDue(definition.catchUp, scheduledAt, now) === "slept") return skip("slept");
    if (this.running.has(definition.id)) return skip("overlap");
    if (!takeDailyRun(state, localDay(now, definition.schedule.timezone), definition.maxRunsPerDay)) return skip("daily-cap");

    this.running.add(definition.id);
    void this.run(definition)
      .catch((err: unknown): RunOutcome => ({ status: "failed", reason: "exit", error: err instanceof Error ? err.message : String(err) }))
      .then((outcome) => {
        this.running.delete(definition.id);
        const finishedAt = this.now();
        const durationMs = finishedAt - now;
        if (outcome.status === "ok") {
          state.failures = 0;
          this.store.appendRun(definition.id, { at: now, status: "ok", durationMs });
        } else {
          state.failures += 1;
          this.store.appendRun(definition.id, { at: now, status: "failed", reason: outcome.reason, durationMs, error: outcome.error });
          if (state.failures >= MAX_FAILURES) {
            state.paused = "failing";
            console.warn(`[workflows] "${definition.name}" paused after ${MAX_FAILURES} failed runs in a row: ${outcome.reason}`);
          }
        }
        // Skipped when the workflow was removed or disabled while it ran.
        if (this.states.get(definition.id) === state) this.store.saveState(this.states);
      });
  }
}
