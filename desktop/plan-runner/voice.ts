// What Marshal says about plans (#278): the `./marshal do plan …` commands of
// the voice dispatcher and the runner's own events, as one spoken sentence.

import { translate, type MessageKey } from "../i18n/catalog.ts";
import type { UiLanguage } from "../i18n/catalog.ts";
import type { Plan, PlanIssue } from "./plan.ts";
import { countSteps } from "./report.ts";
import type { PlanRunner, RunnerEvent, RunRefusal } from "./runner.ts";

const REFUSALS: Record<RunRefusal, MessageKey> = {
  disabled: "plan.disabled",
  busy: "plan.refused.busy",
  missing: "plan.refused.missing",
  broken: "plan.refused.broken",
  done: "plan.refused.done",
  "new-lane": "plan.refused.newLane",
  "no-dispatcher": "plan.refused.noDispatcher",
  "session-missing": "plan.refused.sessionMissing",
  "session-ambiguous": "plan.refused.sessionAmbiguous",
  "session-outside": "plan.refused.sessionOutside",
  "desktop-session": "plan.refused.desktopSession",
  "usage-unknown": "plan.refused.usageUnknown",
  "usage-limit": "plan.refused.usageLimit"
};

const PAUSES: Record<string, MessageKey> = {
  "wall-clock": "plan.pause.wallClock",
  "no-dispatcher": "plan.pause.noDispatcher",
  disabled: "plan.pause.disabled",
  "project-not-allowed": "plan.pause.notAllowed"
};

const STATES: Record<Plan["status"], MessageKey> = {
  draft: "plan.state.draft",
  running: "plan.state.running",
  paused: "plan.state.paused",
  done: "plan.state.done"
};

function issueSentence(issue: PlanIssue | undefined, lang: UiLanguage): string {
  if (issue?.code === "forbidden") return translate(lang, "plan.forbidden", { step: issue.stepId ?? "?", word: issue.word ?? "?" });
  if (issue?.code === "project-not-allowed") return translate(lang, "plan.notAllowed");
  return translate(lang, "plan.notSaved", { reason: issue?.message ?? "?" });
}

export function planStatusSentence(plan: Plan, lang: UiLanguage): string {
  const counts = countSteps(plan);
  return `${translate(lang, "plan.status", { title: plan.title, ...counts })} ${translate(lang, STATES[plan.status])}`;
}

/** The sentence for something the runner did on its own. */
export function planEventSentence(event: RunnerEvent, lang: UiLanguage): string {
  if (event.kind === "finished") {
    const counts = countSteps(event.plan);
    return translate(lang, "plan.event.finished", { title: event.plan.title, ...counts });
  }
  if (event.kind === "paused") return translate(lang, PAUSES[event.reason] ?? "plan.pause.other", { title: event.plan.title });
  const lane = event.plan.steps.find((step) => step.id === event.stepId)?.lane;
  const name = event.plan.lanes.find((candidate) => candidate.id === lane)?.session ?? "?";
  const key: MessageKey =
    event.kind === "blocked" ? "plan.event.blocked" : event.kind === "question" ? "plan.event.question" : "plan.event.failed";
  return translate(lang, key, { step: event.stepId, name });
}

/**
 * `./marshal do plan <create <json> | run [id] | pause | status | report>`.
 * `words` is everything after `plan`. `open` shows a file to the owner.
 */
export function planCommand(runner: PlanRunner, words: string, lang: UiLanguage, open: (file: string) => void = () => {}): string {
  const text = words.trim();
  const verb = (text.split(/\s+/u)[0] ?? "").toLowerCase();
  const rest = text.slice(verb.length).trim();

  if (verb === "create") {
    let raw: unknown;
    try {
      raw = JSON.parse(rest) as unknown;
    } catch {
      return translate(lang, "plan.badJson");
    }
    const created = runner.create(raw);
    if (!created.ok) return issueSentence(created.issues[0], lang);
    return translate(lang, "plan.created", { title: created.plan.title, steps: created.plan.steps.length });
  }

  if (verb === "run" || verb === "resume") {
    const id = rest || runner.latestId(true);
    if (!id) return translate(lang, "plan.none");
    const resumed = runner.load(id)?.status === "paused";
    const result = runner.run(id);
    if (!result.ok) {
      return translate(lang, REFUSALS[result.refusal], { name: result.detail ?? "?", title: result.detail ?? "?", reason: result.detail ?? "?", pct: result.detail ?? "?" });
    }
    return translate(lang, resumed ? "plan.resumed" : "plan.started", { title: result.plan.title, steps: result.plan.steps.length });
  }

  if (verb === "pause" || verb === "stop") {
    return translate(lang, runner.pause() ? "plan.paused" : "plan.notRunning");
  }

  if (verb === "status" || verb === "report") {
    const id = rest || runner.current()?.id || runner.latestId();
    const plan = id ? runner.load(id) : null;
    if (!plan) return translate(lang, "plan.none");
    if (verb === "report") {
      const file = runner.reportPath(plan.id);
      if (file) open(file);
    }
    return planStatusSentence(plan, lang);
  }

  return translate(lang, "plan.unknown");
}
