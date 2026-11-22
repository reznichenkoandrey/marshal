// Runs a plan on sessions that are already open (#278, Stage 2 of
// docs/PLAN_RUNNER.md). It only sends step prompts and records what the
// sessions answer: it starts no session, creates no worktree, and never
// pushes, merges or deploys. One timer exists only while a plan is running.

import fs from "node:fs";
import path from "node:path";

import { isUnderRoots } from "../claude-code/context-router.ts";
import type { ClaudeSession } from "../claude-code/registry.ts";
import { isValidPlanId, parsePlan, type Plan, type PlanIssue } from "./plan.ts";
import { renderReport, REPORT_FILE } from "./report.ts";
import { listPlanIds, loadPlan, planDir, PLAN_FILE, savePlan } from "./store.ts";
import { pausePlan, readMarker, startRun, tick, type StepResult } from "./tick.ts";

export const RUN_LOG_FILE = "run.log";
// Half the pickup wait: a prompt that was not picked up is noticed on time.
export const RUNNER_TICK_MS = 15_000;
const WORKTREE_MARKER = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
const QUESTION_CHARS = 600;

export type RunRefusal =
  | "disabled"
  | "busy"
  | "missing"
  | "broken"
  | "done"
  | "new-lane"
  | "no-dispatcher"
  | "session-missing"
  | "session-ambiguous"
  | "session-outside"
  | "desktop-session"
  | "usage-unknown"
  | "usage-limit";

export type RunnerEvent =
  | { kind: "blocked" | "question" | "failed"; plan: Plan; stepId: string; detail: string | null }
  | { kind: "paused"; plan: Plan; reason: string }
  | { kind: "finished"; plan: Plan };

export type RunnerDeps = {
  /** <userData>/plans */
  plansRoot: string;
  /** The opt-in setting; off = no plan starts and a running one pauses. */
  enabled: () => boolean;
  /** Parsed `claudeCodeRoutingRoots` (#303). */
  roots: () => readonly string[];
  /** Live sessions from the registry. */
  sessions: () => readonly ClaudeSession[];
  /** The dispatcher and `general`: never a lane. */
  isAssistantSession: (session: ClaudeSession) => boolean;
  usagePct: () => number | null;
  /** Whether a prompt can reach a session right now (the dispatcher listens). */
  canDeliver: () => boolean;
  /** Hands one step prompt to the session with this name; false = not handed over. */
  deliver: (session: string, prompt: string) => boolean;
  notify: (event: RunnerEvent) => void;
  now?: () => number;
  /** 0 = no timer (tests drive `tick` themselves). */
  tickMs?: number;
};

export type CreateResult = { ok: true; plan: Plan } | { ok: false; issues: PlanIssue[] };
export type RunResult = { ok: true; plan: Plan } | { ok: false; refusal: RunRefusal; detail?: string };

const inside = (dir: string, root: string): boolean => isUnderRoots(dir, [path.resolve(root)]);

/** The repository a session works in: a worktree under `<repo>/.claude/worktrees/` counts as the repo. */
export function projectOfSession(cwd: string): string {
  const marker = cwd.indexOf(WORKTREE_MARKER);
  return path.resolve(marker >= 0 ? cwd.slice(0, marker) : cwd);
}

export function newPlanId(now: number, taken: readonly string[]): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/gu, "").replace("T", "-").slice(0, 15);
  const base = `plan-${stamp.toLowerCase()}`;
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken.includes(id)) return id;
  }
}

export class PlanRunner {
  private active: Plan | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The plan that is running, or the paused one whose steps may still report. */
  current(): Plan | null {
    return this.active;
  }

  private context(): { roots: readonly string[] } {
    return { roots: this.deps.roots() };
  }

  /**
   * On app start: a plan that was running when Marshal quit is paused, never
   * resumed on its own. The owner resumes it with `plan run`.
   */
  restore(): Plan | null {
    for (const id of listPlanIds(this.deps.plansRoot)) {
      const loaded = loadPlan(this.deps.plansRoot, id, this.context());
      if (!loaded.ok || loaded.plan.status !== "running") continue;
      this.active = pausePlan(loaded.plan, "restart");
      this.persist("paused", { reason: "restart" });
      return this.active;
    }
    return null;
  }

  /** Stores a new plan as a draft. Missing id, lane source and project are filled in; every check of `parsePlan` applies. */
  create(raw: unknown): CreateResult {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return parsePlan(raw, this.context());
    const input = raw as Record<string, unknown>;
    const lanes = Array.isArray(input.lanes)
      ? input.lanes.map((lane: unknown) =>
          typeof lane === "object" && lane !== null ? { source: "existing", ...(lane as Record<string, unknown>) } : lane
        )
      : input.lanes;
    const firstSession = Array.isArray(lanes) ? (lanes[0] as { session?: unknown } | undefined)?.session : undefined;
    const owner = this.deps.sessions().filter((session) => session.name === firstSession);
    const parsed = parsePlan(
      {
        ...input,
        id: input.id ?? newPlanId(this.now(), listPlanIds(this.deps.plansRoot)),
        lanes,
        project: input.project ?? (owner.length === 1 ? projectOfSession(owner[0].cwd) : undefined)
      },
      this.context()
    );
    if (!parsed.ok) return parsed;
    if (fs.existsSync(path.join(planDir(this.deps.plansRoot, parsed.plan.id), PLAN_FILE))) {
      return { ok: false, issues: [{ code: "id", message: `plan ${parsed.plan.id} already exists` }] };
    }
    savePlan(this.deps.plansRoot, parsed.plan);
    this.writeReport(parsed.plan);
    this.log(parsed.plan.id, "created", { steps: parsed.plan.steps.length });
    return parsed;
  }

  /** The stored plan touched last, optionally only one that can still run. */
  latestId(runnable = false): string | null {
    let best: { id: string; mtime: number } | null = null;
    for (const id of listPlanIds(this.deps.plansRoot)) {
      const loaded = loadPlan(this.deps.plansRoot, id, this.context());
      if (!loaded.ok || (runnable && loaded.plan.status === "done")) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(this.deps.plansRoot, id, PLAN_FILE)).mtimeMs;
      } catch {
        // Recovered from the backup: sorts last.
      }
      if (best === null || mtime >= best.mtime) best = { id, mtime };
    }
    return best?.id ?? null;
  }

  load(id: string): Plan | null {
    if (this.active?.id === id) return this.active;
    const loaded = loadPlan(this.deps.plansRoot, id, this.context());
    return loaded.ok ? loaded.plan : null;
  }

  reportPath(id: string): string | null {
    if (!isValidPlanId(id)) return null;
    const file = path.join(this.deps.plansRoot, id, REPORT_FILE);
    return fs.existsSync(file) ? file : null;
  }

  /** Sessions a plan may use: in its project, in the allowed folders, and not the assistant's own. */
  private eligible(plan: Plan): ClaudeSession[] {
    const roots = this.deps.roots();
    return this.deps
      .sessions()
      .filter((session) => !this.deps.isAssistantSession(session) && inside(session.cwd, plan.project) && isUnderRoots(session.cwd, roots));
  }

  /** Starts a draft or resumes a paused plan. Every guard is checked again here, whatever the file says. */
  run(id: string): RunResult {
    const refuse = (refusal: RunRefusal, detail?: string): RunResult => {
      if (isValidPlanId(id) && fs.existsSync(path.join(this.deps.plansRoot, id))) this.log(id, "refused", { refusal, detail });
      return { ok: false, refusal, ...(detail === undefined ? {} : { detail }) };
    };
    if (!this.deps.enabled()) return refuse("disabled");
    if (this.active?.status === "running") return refuse("busy", this.active.title);
    // The active paused plan is newer in memory than on disk only by what is already saved.
    const loaded = loadPlan(this.deps.plansRoot, id, this.context());
    if (!loaded.ok) return refuse(loaded.reason === "missing" || loaded.reason === "invalid-id" ? "missing" : "broken", loaded.issues[0]?.message);
    const plan = loaded.plan;
    if (plan.status === "done") return refuse("done");
    // Starting sessions and worktrees is Stage 3.
    if (plan.lanes.some((lane) => lane.source !== "existing")) return refuse("new-lane");
    if (!this.deps.canDeliver()) return refuse("no-dispatcher");

    const live = this.deps.sessions();
    const eligible = this.eligible(plan);
    for (const lane of plan.lanes) {
      const named = live.filter((session) => session.name === lane.session);
      if (named.length === 0) return refuse("session-missing", lane.session);
      const usable = eligible.filter((session) => session.name === lane.session);
      if (usable.length === 0) return refuse("session-outside", lane.session);
      if (usable.length > 1) return refuse("session-ambiguous", lane.session);
      if (usable[0].entrypoint === "claude-desktop") return refuse("desktop-session", lane.session);
    }
    const usage = this.deps.usagePct();
    if (usage === null) return refuse("usage-unknown");
    if (usage >= plan.limits.stopAtUsagePct) return refuse("usage-limit", String(Math.round(usage)));

    const resumedAfterRestart = plan.status === "paused" && plan.pauseReason === "restart";
    const started = startRun(plan, this.now());
    if (resumedAfterRestart) {
      // The Stop hook of a turn that ended while Marshal was down may be lost:
      // a step still "running" on an idle session is sent again.
      for (const step of started.steps) {
        if (step.state !== "running" && step.state !== "blocked") continue;
        const session = eligible.find((candidate) => candidate.name === started.lanes.find((lane) => lane.id === step.lane)?.session);
        if (session?.status !== "idle") continue;
        step.state = "pending";
        step.sentAt = null;
        step.resent = false;
        step.acked = false;
        step.reason = null;
      }
    }
    this.active = started;
    this.persist(plan.status === "paused" ? "resumed" : "started", { usage });
    this.syncTimer();
    this.tick();
    return { ok: true, plan: this.active ?? started };
  }

  /** Stops sending new steps. Steps in flight finish and still report. */
  pause(reason = "owner"): Plan | null {
    if (this.active?.status !== "running") return null;
    this.active = pausePlan(this.active, reason);
    this.persist("paused", { reason });
    this.syncTimer();
    return this.active;
  }

  /** Stop hook of any session: a lane session's finished turn is its step's answer. */
  onSessionStop(sessionId: string, lastMessage: string): void {
    const plan = this.active;
    if (!plan || plan.status === "done") return;
    const session = this.eligible(plan).find((candidate) => candidate.sessionId === sessionId);
    const lane = session ? plan.lanes.find((candidate) => candidate.session === session.name) : undefined;
    if (!lane) return;
    const step = plan.steps.find(
      (candidate) => candidate.lane === lane.id && (candidate.state === "running" || candidate.state === "blocked" || candidate.state === "question")
    );
    if (!step) return;
    const marker = readMarker(lastMessage);
    if (marker?.stepId != null && marker.stepId !== step.id) {
      // A late answer to another step's prompt.
      this.log(plan.id, "stale-answer", { step: step.id, named: marker.stepId });
      return;
    }
    if (marker === null && step.state === "question") return;
    const body = lastMessage.trimEnd().split(/\r?\n/u).slice(0, marker === null ? undefined : -1).join("\n").trim();
    // No marker = the session did not say the step is done: the owner decides, the runner does not guess.
    const result: StepResult =
      marker === null || marker.outcome === "question"
        ? { stepId: step.id, outcome: "question", question: body.slice(-QUESTION_CHARS) || "(no text)" }
        : { stepId: step.id, outcome: marker.outcome };
    this.log(plan.id, "answer", { step: step.id, outcome: result.outcome, marker: marker !== null });
    this.tick([result]);
  }

  /** One pass of the state machine over the active plan. */
  tick(results: readonly StepResult[] = []): void {
    let plan = this.active;
    if (!plan) return;
    if (plan.status === "running") {
      const stop = !this.deps.enabled() ? "disabled" : !isUnderRoots(plan.project, this.deps.roots()) ? "project-not-allowed" : null;
      if (stop !== null) {
        plan = pausePlan(plan, stop);
        this.active = plan;
        this.persist("paused", { reason: stop });
        this.deps.notify({ kind: "paused", plan, reason: stop });
      }
    }
    const out = tick(plan, { now: this.now(), sessions: this.eligible(plan), usagePct: this.deps.usagePct(), results });
    if (out.changed || out.actions.length > 0) {
      let next = out.plan;
      const events: RunnerEvent[] = [];
      let undelivered = false;
      for (const action of out.actions) {
        if (action.type === "send") {
          const handed = this.deps.deliver(action.session, action.prompt);
          undelivered ||= !handed;
          this.log(next.id, handed ? "sent" : "not-sent", { step: action.stepId, kind: action.kind, session: action.session });
        } else if (action.type === "spawn") {
          // Never executed in this stage: `run` refuses plans with a `new` lane.
          this.log(next.id, "spawn-ignored", { lane: action.lane });
        } else if (action.type === "notify") {
          this.log(next.id, action.kind, { step: action.stepId, detail: action.detail });
          events.push({ kind: action.kind, plan: next, stepId: action.stepId, detail: action.detail });
        } else if (action.type === "pause") {
          this.log(next.id, "paused", { reason: action.reason });
          events.push({ kind: "paused", plan: next, reason: action.reason });
        } else {
          this.log(next.id, "finished", {});
          events.push({ kind: "finished", plan: next });
        }
      }
      if (undelivered && next.status === "running") {
        next = pausePlan(next, "no-dispatcher");
        this.log(next.id, "paused", { reason: "no-dispatcher" });
        events.push({ kind: "paused", plan: next, reason: "no-dispatcher" });
      }
      this.active = next;
      savePlan(this.deps.plansRoot, next);
      this.writeReport(next);
      for (const event of events) this.deps.notify({ ...event, plan: next });
    }
    this.syncTimer();
  }

  /** On quit: the timer goes; the plan on disk stays `running` and `restore` pauses it on the next start. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private syncTimer(): void {
    const wanted = this.active?.status === "running" && (this.deps.tickMs ?? RUNNER_TICK_MS) > 0;
    if (wanted && !this.timer) {
      this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? RUNNER_TICK_MS);
      this.timer.unref?.();
    } else if (!wanted && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private persist(event: string, fields: Record<string, unknown>): void {
    if (!this.active) return;
    savePlan(this.deps.plansRoot, this.active);
    this.writeReport(this.active);
    this.log(this.active.id, event, fields);
  }

  private writeReport(plan: Plan): void {
    try {
      fs.writeFileSync(path.join(planDir(this.deps.plansRoot, plan.id), REPORT_FILE), renderReport(plan, this.now()), { mode: 0o600 });
    } catch (err) {
      console.warn("[plan-runner] report not written:", err instanceof Error ? err.message : err);
    }
  }

  /** Append-only: one JSON line per thing the runner did or refused to do. Step text and answers are not logged. */
  private log(id: string, event: string, fields: Record<string, unknown>): void {
    try {
      const line = JSON.stringify({ at: new Date(this.now()).toISOString(), event, ...fields });
      fs.appendFileSync(path.join(planDir(this.deps.plansRoot, id), RUN_LOG_FILE), `${line}\n`, { mode: 0o600 });
    } catch (err) {
      console.warn("[plan-runner] log not written:", err instanceof Error ? err.message : err);
    }
  }
}
