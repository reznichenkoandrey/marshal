// What the owner hears when sessions wait (#385): one sentence per burst of
// hook events, grouped by project, saying whether each waits for an answer or
// for a permission. Pure, so the wording and the question/permission rule are
// pinned by tests.

import type { UiLanguage } from "../i18n/catalog.ts";

export type WaitingSession = { project: string; question: boolean };

export type WaitingSignal = {
  /** The hook said permission_prompt; elicitation dialogs arrive as input. */
  confirmation: boolean;
  /** The Notification `message`. */
  message: string;
  /** `waitingFor` from the session registry, when the session is listed there. */
  waitingFor: string | null;
};

// Claude Code 2.1.321: AskUserQuestion arrives as a permission_prompt with the
// generic "Claude needs your permission" (the SDK path names the tool), and only
// the registry says "input needed"; a plan arrives as "...needs your approval for the plan".
const QUESTION_MESSAGE = /AskUserQuestion|ExitPlanMode|EnterPlanMode|\bplan\b|question/i;

/** A question or a plan to approve waits for an answer; anything else for a permission. */
export function isQuestionWait(signal: WaitingSignal): boolean {
  return !signal.confirmation || signal.waitingFor === "input needed" || QUESTION_MESSAGE.test(signal.message);
}

/** "100-balloons" and "snoriq_redesign" read as words, not as "hyphen" or "underscore". */
export function speakableProject(project: string): string {
  return project.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim() || project;
}

const UK_FEMININE = ["", "одна", "дві", "три", "чотири", "п'ять", "шість", "сім", "вісім", "дев'ять", "десять"];
const EN_NUMBERS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function ukForm(count: number): "one" | "few" | "many" {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "one";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
  return "many";
}

function ukSessions(count: number, question: boolean): string {
  const form = ukForm(count);
  const noun = form === "one" ? "сесія" : form === "few" ? "сесії" : "сесій";
  const verb = form === "one" ? "чекає" : "чекають";
  return `${UK_FEMININE[count] ?? String(count)} ${noun} ${verb} ${question ? "відповіді" : "дозволу"}`;
}

function enSessions(count: number, question: boolean): string {
  const noun = count === 1 ? "session needs" : "sessions need";
  return `${EN_NUMBERS[count] ?? String(count)} ${noun} ${question ? "an answer" : "permission"}`;
}

/** "У проєкті marshal дві сесії чекають відповіді. У проєкті 100 balloons одна сесія чекає дозволу." */
export function describeWaiting(sessions: readonly WaitingSession[], lang: UiLanguage): string {
  const projects = new Map<string, { questions: number; permissions: number }>();
  for (const session of sessions) {
    const counts = projects.get(session.project) ?? { questions: 0, permissions: 0 };
    if (session.question) counts.questions += 1;
    else counts.permissions += 1;
    projects.set(session.project, counts);
  }
  const uk = lang === "uk";
  return [...projects].map(([project, { questions, permissions }]) => {
    const parts: string[] = [];
    if (questions) parts.push(uk ? ukSessions(questions, true) : enSessions(questions, true));
    if (permissions) parts.push(uk ? ukSessions(permissions, false) : enSessions(permissions, false));
    const name = speakableProject(project);
    return uk ? `У проєкті ${name} ${parts.join(", ")}.` : `In ${name}, ${parts.join(", ")}.`;
  }).join(" ");
}
