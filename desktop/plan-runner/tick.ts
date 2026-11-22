// The plan runner's state machine (#278, docs/PLAN_RUNNER.md). `tick` is pure:
// (plan, facts) → (next plan, actions). It starts nothing and writes nothing;
// a separate layer sends prompts, starts sessions and saves the plan.

import type { ClaudeSession } from "../claude-code/registry.ts";
import { findForbidden } from "./forbidden.ts";
import type { Plan, PlanLane, PlanStep, StepState } from "./plan.ts";

// A sent prompt the session has not picked up is repeated once after this long.
export const PICKUP_WAIT_MS = 30_000;
// Same wait as the dispatcher's `./marshal spawn`.
export const SPAWN_WAIT_MS = 45_000;
// A lane whose session keeps dying is not restarted forever.
export const MAX_SPAWNS = 3;
// A notBefore step that starts later than this counts as late in the report.
const LATE_MS = 60_000;

export type SessionFact = Pick<ClaudeSession, "name" | "status" | "waitingFor" | "entrypoint">;

export type StepOutcome = "done" | "failed" | "question";

export type StepResult = {
  stepId: string;
  outcome: StepOutcome;
  question?: string;
  // The provider or network failed: not the step's fault, so no fix round.
  provider?: boolean;
};

export type TickFacts = {
  now: number;
  // Live sessions from the registry.
  sessions: readonly SessionFact[];
  // 5-hour usage in percent; null = unknown, and unknown starts nothing.
  usagePct: number | null;
  // Step results that arrived since the last tick (Stop hook of a lane session).
  results?: readonly StepResult[];
};

export type PlanAction =
  | { type: "send"; kind: "step" | "resend" | "fix"; stepId: string; lane: string; session: string; prompt: string }
  | { type: "spawn"; lane: string; session: string }
  | { type: "notify"; kind: "blocked" | "question" | "failed"; stepId: string; detail: string | null }
  | { type: "pause"; reason: string }
  | { type: "finish" };

export type TickResult = { plan: Plan; actions: PlanAction[]; changed: boolean };

const TERMINAL: readonly StepState[] = ["done", "failed", "held", "skipped"];
const LANE_BUSY: readonly StepState[] = ["running", "blocked", "question"];
const FORBIDDEN_RULE =
  "Do not push, pull, merge, rebase, deploy, release, delete branches or worktrees, or discard changes " +
  "(reset --hard, git clean). Commit locally if the step needs a commit.";

/** Marks the plan running. The first run fixes `runStartedAt`; every run opens a new wall-clock window. */
export function startRun(plan: Plan, now: number): Plan {
  if (plan.status === "done") return plan;
  return { ...plan, status: "running", runStartedAt: plan.runStartedAt ?? now, wallStartedAt: now, pauseReason: null };
}

export function pausePlan(plan: Plan, reason: string): Plan {
  return plan.status === "running" ? { ...plan, status: "paused", pauseReason: reason } : plan;
}

export function stepPrompt(plan: Pick<Plan, "title" | "limits">, step: PlanStep): string {
  const head =
    step.fixRounds > 0
      ? `The previous attempt at step ${step.id} of the unattended plan "${plan.title}" failed. ` +
        `Fix the cause and repeat the check (fix round ${step.fixRounds} of ${plan.limits.maxFixRounds}). The step:`
      : `You are running step ${step.id} of the unattended plan "${plan.title}". Nobody is at the keyboard.`;
  return [
    head,
    step.text,
    ...(step.check === null ? [] : [`Done when: ${step.check}`]),
    `Rules: work only inside this folder. ${FORBIDDEN_RULE} ` +
      "If you need a decision from the owner, do not guess: ask one question and stop.",
    "End your reply with one last line, exactly one of:\nPLAN-STEP: done\nPLAN-STEP: failed\nPLAN-STEP: question"
  ].join("\n\n");
}

/** The outcome the session declared on the last line of its answer, or null when it did not. */
export function parseMarker(answer: string): StepOutcome | null {
  const last = answer.trimEnd().split(/\r?\n/u).at(-1) ?? "";
  const match = /^PLAN-STEP:\s*(done|failed|question)$/iu.exec(last.replace(/[`*_]/gu, "").trim());
  return match ? (match[1].toLowerCase() as StepOutcome) : null;
}

const squash = (text: string): string => text.toLowerCase().replace(/\s+/gu, " ").trim();

/**
 * Whether a model's answer to a step's question may be sent without the owner:
 * only when the answer is literally in the plan text, and never when the
 * question or the answer touches push, merge, deploy or delete.
 */
export function modelMayAnswer(question: string, answer: string, plan: Pick<Plan, "title" | "steps">): boolean {
  if (findForbidden(question) !== null || findForbidden(answer) !== null) return false;
  const needle = squash(answer).replace(/[.!?…]+$/u, "");
  if (needle.length < 3) return false;
  const planText = squash([plan.title, ...plan.steps.flatMap((step) => [step.text, step.check ?? ""])].join("\n"));
  return planText.includes(needle);
}

type Lookup = { kind: "found"; session: SessionFact } | { kind: "missing" } | { kind: "ambiguous" };

function findSession(lane: PlanLane, sessions: readonly SessionFact[]): Lookup {
  const matches = sessions.filter((session) => session.name === lane.session);
  if (matches.length === 0) return { kind: "missing" };
  return matches.length === 1 ? { kind: "found", session: matches[0] } : { kind: "ambiguous" };
}

export function tick(current: Plan, facts: TickFacts): TickResult {
  if (current.status !== "running") return { plan: current, actions: [], changed: false };
  const plan = structuredClone(current);
  const actions: PlanAction[] = [];
  const { now } = facts;
  const lanes = new Map(plan.lanes.map((lane) => [lane.id, lane]));
  const steps = new Map(plan.steps.map((step) => [step.id, step]));
  const overWall = now - (plan.wallStartedAt ?? plan.runStartedAt ?? now) >= plan.limits.maxWallMinutes * 60_000;

  const fail = (step: PlanStep, reason: string): void => {
    step.state = "failed";
    step.reason = reason;
    step.finishedAt = now;
    actions.push({ type: "notify", kind: "failed", stepId: step.id, detail: reason });
  };
  const requeue = (step: PlanStep): void => {
    step.state = "pending";
    step.sentAt = null;
    step.resent = false;
    step.acked = false;
  };
  const send = (step: PlanStep, lane: PlanLane, kind: "step" | "resend" | "fix"): void => {
    step.sentAt = now;
    actions.push({ type: "send", kind, stepId: step.id, lane: lane.id, session: lane.session, prompt: stepPrompt(plan, step) });
  };

  // 1. Results declared by the sessions.
  for (const result of facts.results ?? []) {
    const step = steps.get(result.stepId);
    if (!step || (step.state !== "running" && step.state !== "blocked")) continue;
    if (result.outcome === "done") {
      step.state = "done";
      step.reason = null;
      step.finishedAt = now;
    } else if (result.outcome === "question") {
      step.state = "question";
      step.question = result.question?.trim() || null;
      actions.push({ type: "notify", kind: "question", stepId: step.id, detail: step.question });
    } else if (result.provider === true) {
      fail(step, "provider");
    } else if (step.fixRounds < plan.limits.maxFixRounds) {
      // Back to pending: the fix round passes the same gates as a first start.
      step.fixRounds += 1;
      requeue(step);
    } else {
      fail(step, "fix-rounds-exhausted");
    }
  }

  // 2. What the registry says about steps in flight.
  for (const step of plan.steps) {
    if (step.state !== "running" && step.state !== "blocked") continue;
    const lane = lanes.get(step.lane) as PlanLane;
    const found = findSession(lane, facts.sessions);
    if (found.kind === "ambiguous") {
      fail(step, "session-ambiguous");
    } else if (found.kind === "missing") {
      if (lane.source === "existing") fail(step, "session-gone");
      else requeue(step);
    } else if (found.session.status === "waiting") {
      step.acked = true;
      if (step.state !== "blocked") {
        // The runner never answers a dialog: the owner does.
        step.state = "blocked";
        step.reason = found.session.waitingFor ?? "waiting";
        actions.push({ type: "notify", kind: "blocked", stepId: step.id, detail: step.reason });
      }
    } else if (step.state === "blocked") {
      step.state = "running";
      step.reason = null;
    } else if (!step.acked) {
      if (found.session.status === "busy" || found.session.status === "shell") {
        step.acked = true;
      } else if (!overWall && step.sentAt !== null && now - step.sentAt >= PICKUP_WAIT_MS) {
        if (step.resent) {
          fail(step, "not-picked-up");
        } else {
          step.resent = true;
          send(step, lane, "resend");
        }
      }
    }
  }

  holdDependents(plan.steps);

  // 3. Hard stop: the wall-clock window is over. Steps in flight finish; nothing new is sent.
  if (overWall) {
    plan.status = "paused";
    plan.pauseReason = "wall-clock";
    actions.push({ type: "pause", reason: "wall-clock" });
    return { plan, actions, changed: true };
  }

  // 4. Start the next step of every free lane.
  const usageOpen = facts.usagePct !== null && facts.usagePct < plan.limits.stopAtUsagePct;
  for (const lane of plan.lanes) {
    const laneSteps = plan.steps.filter((step) => step.lane === lane.id);
    if (laneSteps.some((step) => LANE_BUSY.includes(step.state))) continue;
    const step = laneSteps.find((candidate) => candidate.state === "pending");
    if (!step || !usageOpen) continue;
    if (!step.dependsOn.every((id) => steps.get(id)?.state === "done")) continue;
    const notBefore = step.notBefore === null ? null : Date.parse(step.notBefore);
    if (notBefore !== null && notBefore > now) continue;

    const found = findSession(lane, facts.sessions);
    if (found.kind === "ambiguous") {
      fail(step, "session-ambiguous");
      continue;
    }
    if (found.kind === "missing") {
      if (lane.source === "existing") {
        fail(step, "session-gone");
      } else if (lane.spawnedAt === null || now - lane.spawnedAt >= SPAWN_WAIT_MS) {
        if (lane.spawns >= MAX_SPAWNS) {
          fail(step, "spawn-failed");
        } else {
          lane.spawnedAt = now;
          lane.spawns += 1;
          actions.push({ type: "spawn", lane: lane.id, session: lane.session });
        }
      }
      continue;
    }
    lane.spawnedAt = null;
    // The runner cannot watch, stop or restart a Claude desktop session (#437).
    if (found.session.entrypoint === "claude-desktop") {
      fail(step, "desktop-session");
      continue;
    }
    if (found.session.status !== "idle") continue;

    step.state = "running";
    step.reason = null;
    step.resent = false;
    step.acked = false;
    step.startedAt ??= now;
    if (notBefore !== null && now - notBefore > LATE_MS) step.lateMs = now - notBefore;
    send(step, lane, step.fixRounds > 0 ? "fix" : "step");
  }

  holdDependents(plan.steps);

  if (plan.steps.every((step) => TERMINAL.includes(step.state))) {
    plan.status = "done";
    actions.push({ type: "finish" });
  }
  return { plan, actions, changed: JSON.stringify(plan) !== JSON.stringify(current) };
}

/** A step that can never run, because something it depends on did not finish, is held, and so on down the graph. */
export function holdDependents(steps: PlanStep[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (let moved = true; moved; ) {
    moved = false;
    for (const step of steps) {
      if (step.state !== "pending") continue;
      const dead = step.dependsOn.find((id) => {
        const state = byId.get(id)?.state;
        return state === "failed" || state === "held" || state === "skipped";
      });
      if (dead === undefined) continue;
      step.state = "held";
      step.reason = `depends-on:${dead}`;
      moved = true;
    }
  }
}
