// Plans on disk (#278): <root>/<planId>/plan.json, written on every state
// change so a crash or a sleep resumes from the last state. No database.

import fs from "node:fs";
import path from "node:path";

import { isValidPlanId, parsePlan, type Plan, type PlanContext, type PlanIssue } from "./plan.ts";

export const PLAN_FILE = "plan.json";
// The last version that was read back valid; used when plan.json is broken.
export const PLAN_BACKUP_FILE = "plan.json.bak";

export type LoadResult =
  | { ok: true; plan: Plan; recovered: boolean }
  | { ok: false; reason: "invalid-id" | "missing" | "broken"; issues: PlanIssue[] };

export function planDir(root: string, id: string): string {
  if (!isValidPlanId(id)) throw new Error("invalid plan id");
  return path.join(root, id);
}

/**
 * Atomic: a crash mid-write leaves the previous plan.json intact. The previous
 * file is kept as the backup only while it still parses, so a broken file
 * never replaces a good backup.
 */
export function savePlan(root: string, plan: Plan): void {
  const dir = planDir(root, plan.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, PLAN_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  if (readJson(file) !== undefined) fs.copyFileSync(file, path.join(dir, PLAN_BACKUP_FILE));
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Reads a plan back with every creation check applied again. A plan.json that
 * does not parse or no longer passes falls back to the backup; the broken file
 * is left in place for the owner to look at. Nothing is guessed: with no valid
 * copy the plan does not load.
 */
export function loadPlan(root: string, id: string, context: PlanContext): LoadResult {
  if (!isValidPlanId(id)) return { ok: false, reason: "invalid-id", issues: [] };
  const dir = path.join(root, id);
  const file = path.join(dir, PLAN_FILE);
  const backup = path.join(dir, PLAN_BACKUP_FILE);
  if (!fs.existsSync(file) && !fs.existsSync(backup)) return { ok: false, reason: "missing", issues: [] };

  let issues: PlanIssue[] = [];
  for (const [candidate, recovered] of [[file, false], [backup, true]] as const) {
    const raw = readJson(candidate);
    if (raw === undefined) {
      if (!recovered) issues = [{ code: "shape", message: `${PLAN_FILE} is not valid JSON` }];
      continue;
    }
    const parsed = parsePlan(raw, context, { stored: true });
    // A file copied into another plan's folder is not that plan.
    if (parsed.ok && parsed.plan.id === id) return { ok: true, plan: parsed.plan, recovered };
    if (!recovered) issues = parsed.ok ? [{ code: "id", message: "plan id does not match its folder" }] : parsed.issues;
  }
  return { ok: false, reason: "broken", issues };
}

/** Ids of the plans stored under root, newest folder name last. */
export function listPlanIds(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidPlanId(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
