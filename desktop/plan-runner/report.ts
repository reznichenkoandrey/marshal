// The morning report of a plan (#278): report.md next to plan.json, rewritten
// on every state change. Pure text from the plan; the runner writes the file.

import type { Plan, PlanStep, StepState } from "./plan.ts";

export const REPORT_FILE = "report.md";

export type PlanCounts = { total: number; done: number; running: number; waiting: number; failed: number; pending: number };

/** `waiting` = steps that stand until the owner acts: a dialog or a question. */
export function countSteps(plan: Pick<Plan, "steps">): PlanCounts {
  const count = (...states: StepState[]): number => plan.steps.filter((step) => states.includes(step.state)).length;
  return {
    total: plan.steps.length,
    done: count("done"),
    running: count("running"),
    waiting: count("blocked", "question"),
    failed: count("failed", "held"),
    pending: count("pending")
  };
}

const time = (at: number | null): string => (at === null ? "—" : new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC");
const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();

function stepLine(step: PlanStep, session: string): string {
  const notes = [
    step.reason === null ? null : `reason: ${step.reason}`,
    step.fixRounds > 0 ? `fix rounds: ${step.fixRounds}` : null,
    step.resent ? "prompt repeated" : null,
    step.lateMs === null ? null : `started ${Math.round(step.lateMs / 60_000)} min late`,
    step.question === null ? null : `question: ${oneLine(step.question)}`
  ].filter((note): note is string => note !== null);
  return (
    `- **${step.id}** [${step.state}] (${session}) ${oneLine(step.text)}` +
    `\n  - started ${time(step.startedAt)}, finished ${time(step.finishedAt)}` +
    (notes.length > 0 ? `\n  - ${notes.join("; ")}` : "")
  );
}

export function renderReport(plan: Plan, now: number): string {
  const counts = countSteps(plan);
  const sessions = new Map(plan.lanes.map((lane) => [lane.id, lane.session]));
  const needsOwner = plan.steps.filter((step) => step.state === "blocked" || step.state === "question");
  return [
    `# ${plan.title}`,
    "",
    `Plan \`${plan.id}\` in \`${plan.project}\`. Status: **${plan.status}**` +
      (plan.pauseReason === null ? "" : ` (${plan.pauseReason})`) +
      `. Written ${time(now)}.`,
    `Started ${time(plan.runStartedAt)}. Steps: ${counts.done} of ${counts.total} done, ${counts.running} running, ` +
      `${counts.waiting} waiting for you, ${counts.failed} failed or held, ${counts.pending} not started.`,
    "",
    ...(needsOwner.length === 0
      ? []
      : ["## Needs you", "", ...needsOwner.map((step) => stepLine(step, sessions.get(step.lane) ?? step.lane)), ""]),
    "## Steps",
    "",
    ...plan.steps.map((step) => stepLine(step, sessions.get(step.lane) ?? step.lane)),
    "",
    "The runner sent prompts only. It did not push, merge, deploy or delete anything; review the sessions' commits yourself.",
    ""
  ].join("\n");
}
