// The overnight plan (#278, docs/PLAN_RUNNER.md): its shape and the checks a
// plan must pass before it is stored or resumed. Pure: no fs, no Electron.

import path from "node:path";

import { isUnderRoots } from "../claude-code/context-router.ts";
import { findForbidden } from "./forbidden.ts";

export const STEP_STATES = ["pending", "running", "blocked", "question", "failed", "held", "done", "skipped"] as const;
export type StepState = (typeof STEP_STATES)[number];
export const PLAN_STATUSES = ["draft", "running", "paused", "done"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type LaneSource = "existing" | "new";

export type PlanLane = {
  id: string;
  // Name of the Claude Code session that runs this lane's steps.
  session: string;
  source: LaneSource;
  // When the runner last asked for this lane's session to be started, and how often.
  spawnedAt: number | null;
  spawns: number;
};

export type PlanStep = {
  id: string;
  lane: string;
  text: string;
  dependsOn: string[];
  // Readiness condition, passed to the session with the step; the runner never runs it.
  check: string | null;
  // ISO time before which the step does not start.
  notBefore: string | null;
  state: StepState;
  fixRounds: number;
  // Why the step is failed, held or blocked.
  reason: string | null;
  question: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  // Last time the prompt was sent, whether it was already repeated, and
  // whether the session was seen busy since.
  sentAt: number | null;
  resent: boolean;
  acked: boolean;
  // How late a notBefore step started (the Mac slept through its time).
  lateMs: number | null;
};

export type PlanLimits = { maxFixRounds: number; maxWallMinutes: number; stopAtUsagePct: number };

export type Plan = {
  id: string;
  title: string;
  project: string;
  // Branch or commit the lane worktrees start from.
  base: string;
  lanes: PlanLane[];
  steps: PlanStep[];
  limits: PlanLimits;
  status: PlanStatus;
  runStartedAt: number | null;
  // Start of the current wall-clock window; a resume opens a new one.
  wallStartedAt: number | null;
  pauseReason: string | null;
};

export const DEFAULT_LIMITS: PlanLimits = { maxFixRounds: 2, maxWallMinutes: 480, stopAtUsagePct: 97 };
// The usage limit is shared by every session, so more lanes only race for it.
export const MAX_LANES = 2;
export const MAX_STEPS = 50;
const MAX_TEXT = 4000;
const LIMIT_RANGES: Record<keyof PlanLimits, readonly [number, number]> = {
  maxFixRounds: [0, 5],
  maxWallMinutes: [1, 1440],
  // 97 is a ceiling, not a default a plan may raise.
  stopAtUsagePct: [1, DEFAULT_LIMITS.stopAtUsagePct]
};

// The id becomes a folder and a branch name; the session name goes into a shell command.
const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/u;
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

export type PlanIssue = {
  code:
    | "shape"
    | "id"
    | "title"
    | "project"
    | "project-not-allowed"
    | "base"
    | "lanes"
    | "steps"
    | "dependency"
    | "cycle"
    | "forbidden"
    | "limits";
  message: string;
  stepId?: string;
  // The forbidden operation a step asked for.
  word?: string;
};

export type PlanContext = {
  // Folders the runner may work in: the parsed `claudeCodeRoutingRoots` (#303). Empty = no plan is accepted.
  roots: readonly string[];
};

export type PlanResult = { ok: true; plan: Plan } | { ok: false; issues: PlanIssue[] };

export function isValidPlanId(id: unknown): id is string {
  return typeof id === "string" && PLAN_ID.test(id);
}

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const timeOrNull = (value: unknown): number | null => (isTime(value) ? value : null);
const textOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * Checks a plan and fills its defaults. `stored: false` is a new plan: every
 * step starts `pending` whatever the input says. `stored: true` is a plan read
 * back from disk: run state is kept, and the same safety checks run again, so
 * a file edited by hand cannot smuggle in a forbidden step or a foreign folder.
 */
export function parsePlan(raw: unknown, context: PlanContext, options: { stored?: boolean } = {}): PlanResult {
  const stored = options.stored === true;
  if (!isObject(raw)) return { ok: false, issues: [{ code: "shape", message: "plan must be a JSON object" }] };
  const issues: PlanIssue[] = [];

  if (!isValidPlanId(raw.id)) {
    issues.push({ code: "id", message: "plan id must be lowercase letters, digits and dashes (max 64)" });
  }
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (title === "" || title.length > 200) issues.push({ code: "title", message: "plan needs a title (max 200 characters)" });

  const project = typeof raw.project === "string" && path.isAbsolute(raw.project) ? path.resolve(raw.project) : null;
  if (project === null) {
    issues.push({ code: "project", message: "plan project must be an absolute folder path" });
  } else if (!isUnderRoots(project, context.roots)) {
    issues.push({
      code: "project-not-allowed",
      message:
        context.roots.length === 0
          ? "no folders are allowed yet: add the project to Settings → Claude Code → folders whose sessions may be read"
          : `project ${project} is outside the allowed folders`
    });
  }

  const base = raw.base === undefined || raw.base === null ? "main" : raw.base;
  if (typeof base !== "string" || !GIT_REF.test(base) || base.includes("..")) {
    issues.push({ code: "base", message: "plan base must be a branch name or a commit" });
  }

  const lanes = parseLanes(raw.lanes, stored, issues);
  const steps = parseSteps(raw.steps, new Set(lanes.map((lane) => lane.id)), stored, issues);
  const limits = parseLimits(raw.limits, issues);

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    plan: {
      id: raw.id as string,
      title,
      project: project as string,
      base: base as string,
      lanes,
      steps,
      limits,
      status: stored && PLAN_STATUSES.includes(raw.status as PlanStatus) ? (raw.status as PlanStatus) : "draft",
      runStartedAt: stored ? timeOrNull(raw.runStartedAt) : null,
      wallStartedAt: stored ? timeOrNull(raw.wallStartedAt) : null,
      pauseReason: stored ? textOrNull(raw.pauseReason) : null
    }
  };
}

function parseLanes(raw: unknown, stored: boolean, issues: PlanIssue[]): PlanLane[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LANES) {
    issues.push({ code: "lanes", message: `plan needs 1 to ${MAX_LANES} lanes` });
    return [];
  }
  const lanes: PlanLane[] = [];
  for (const item of raw) {
    if (!isObject(item) || typeof item.id !== "string" || !SHORT_ID.test(item.id)) {
      issues.push({ code: "lanes", message: "lane id must be short letters and digits" });
      continue;
    }
    if (typeof item.session !== "string" || !SESSION_NAME.test(item.session)) {
      issues.push({ code: "lanes", message: `lane ${item.id}: session name must be letters, digits, dot, dash or underscore` });
      continue;
    }
    if (item.source !== "existing" && item.source !== "new") {
      issues.push({ code: "lanes", message: `lane ${item.id}: source must be "existing" or "new"` });
      continue;
    }
    if (lanes.some((lane) => lane.id === item.id || lane.session === item.session)) {
      issues.push({ code: "lanes", message: `lane ${item.id}: lane ids and session names must be unique` });
      continue;
    }
    lanes.push({
      id: item.id,
      session: item.session,
      source: item.source,
      spawnedAt: stored ? timeOrNull(item.spawnedAt) : null,
      spawns: stored && Number.isInteger(item.spawns) && (item.spawns as number) >= 0 ? (item.spawns as number) : 0
    });
  }
  return lanes;
}

function parseSteps(raw: unknown, laneIds: ReadonlySet<string>, stored: boolean, issues: PlanIssue[]): PlanStep[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STEPS) {
    issues.push({ code: "steps", message: `plan needs 1 to ${MAX_STEPS} steps` });
    return [];
  }
  const steps: PlanStep[] = [];
  for (const item of raw) {
    if (!isObject(item) || typeof item.id !== "string" || !SHORT_ID.test(item.id)) {
      issues.push({ code: "steps", message: "step id must be short letters and digits" });
      continue;
    }
    const stepId = item.id;
    const fail = (code: PlanIssue["code"], message: string, word?: string): void => {
      issues.push({ code, message: `step ${stepId}: ${message}`, stepId, ...(word ? { word } : {}) });
    };
    if (steps.some((step) => step.id === stepId)) {
      fail("steps", "step ids must be unique");
      continue;
    }
    if (typeof item.lane !== "string" || !laneIds.has(item.lane)) {
      fail("steps", "lane does not exist");
      continue;
    }
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text === "" || text.length > MAX_TEXT) {
      fail("steps", `text is required (max ${MAX_TEXT} characters)`);
      continue;
    }
    const check = item.check === undefined || item.check === null ? null : item.check;
    if (check !== null && (typeof check !== "string" || check.length > MAX_TEXT)) {
      fail("steps", "check must be text");
      continue;
    }
    const word = findForbidden(text) ?? (check === null ? null : findForbidden(check));
    if (word !== null) {
      fail("forbidden", `asks for "${word}", which the runner never does; rephrase the step or do it yourself`, word);
      continue;
    }
    const notBefore = item.notBefore === undefined || item.notBefore === null ? null : item.notBefore;
    if (notBefore !== null && (typeof notBefore !== "string" || Number.isNaN(Date.parse(notBefore)))) {
      fail("steps", "notBefore must be an ISO time");
      continue;
    }
    const dependsOn = item.dependsOn === undefined ? [] : item.dependsOn;
    if (!Array.isArray(dependsOn) || !dependsOn.every((id): id is string => typeof id === "string")) {
      fail("dependency", "dependsOn must be a list of step ids");
      continue;
    }
    if (stored && !STEP_STATES.includes(item.state as StepState)) {
      fail("steps", "unknown state");
      continue;
    }
    steps.push({
      id: stepId,
      lane: item.lane,
      text,
      dependsOn: [...new Set(dependsOn)],
      check: check === null || check.trim() === "" ? null : check.trim(),
      notBefore,
      state: stored ? (item.state as StepState) : "pending",
      fixRounds: stored && Number.isInteger(item.fixRounds) && (item.fixRounds as number) >= 0 ? (item.fixRounds as number) : 0,
      reason: stored ? textOrNull(item.reason) : null,
      question: stored ? textOrNull(item.question) : null,
      startedAt: stored ? timeOrNull(item.startedAt) : null,
      finishedAt: stored ? timeOrNull(item.finishedAt) : null,
      sentAt: stored ? timeOrNull(item.sentAt) : null,
      resent: stored && item.resent === true,
      acked: stored && item.acked === true,
      lateMs: stored ? timeOrNull(item.lateMs) : null
    });
  }

  const ids = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id || !ids.has(dep)) {
        issues.push({ code: "dependency", message: `step ${step.id}: depends on unknown step ${dep}`, stepId: step.id });
      }
    }
  }
  const cycle = findCycle(steps);
  if (cycle !== null) issues.push({ code: "cycle", message: `step ${cycle}: dependencies form a cycle`, stepId: cycle });
  return steps;
}

/** Id of a step that sits on a dependency cycle, or null. */
export function findCycle(steps: readonly Pick<PlanStep, "id" | "dependsOn">[]): string | null {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map<string, "open" | "closed">();
  const visit = (id: string): string | null => {
    if (state.get(id) === "closed") return null;
    if (state.get(id) === "open") return id;
    state.set(id, "open");
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const hit = visit(dep);
      if (hit !== null) return hit;
    }
    state.set(id, "closed");
    return null;
  };
  for (const step of steps) {
    const hit = visit(step.id);
    if (hit !== null) return hit;
  }
  return null;
}

function parseLimits(raw: unknown, issues: PlanIssue[]): PlanLimits {
  const limits = { ...DEFAULT_LIMITS };
  if (raw === undefined || raw === null) return limits;
  if (!isObject(raw)) {
    issues.push({ code: "limits", message: "limits must be an object" });
    return limits;
  }
  for (const key of Object.keys(LIMIT_RANGES) as (keyof PlanLimits)[]) {
    const value = raw[key];
    if (value === undefined) continue;
    const [min, max] = LIMIT_RANGES[key];
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      issues.push({ code: "limits", message: `${key} must be a whole number from ${min} to ${max}` });
      continue;
    }
    limits[key] = value as number;
  }
  return limits;
}
