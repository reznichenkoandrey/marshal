// Builds a workflow definition from the owner's words (#280). The model turns
// the phrase into JSON; the validator decides, with one retry that quotes it.

import { randomUUID } from "node:crypto";

import { validateDefinition, type WorkflowDefinition } from "./definition.ts";

/** Voice-built workflows get only these: MCP tool names cannot be checked against the servers yet. */
export const BUILDER_TOOLS = ["WebSearch", "WebFetch", "Read", "Grep", "Glob"] as const;

export type BuildResult =
  | { kind: "built"; definition: WorkflowDefinition; summary: string }
  | { kind: "clarify"; question: string }
  | { kind: "failed"; errors: string[] }
  | { kind: "no-model" };

export interface BuildOptions {
  /** One model call; null when no provider is configured or the call failed. */
  complete: (request: { system: string; user: string }) => Promise<string | null>;
  timezone: string;
  language: "uk" | "en";
  newId?: () => string;
}

export function builderSystemPrompt(timezone: string, language: "uk" | "en"): string {
  return [
    "You turn a spoken request into the definition of a scheduled workflow. Answer with one JSON object and nothing else.",
    "",
    "Shape when the request names a schedule:",
    '{"name": "<2-5 words>", "cron": "<minute hour day-of-month month day-of-week>", "prompt": "<the task for an unattended agent, written out in full>", "allowedTools": [<names>], "summary": "<when it runs, in plain words>"}',
    "",
    "Rules:",
    `- cron has exactly five numeric fields, in the ${timezone} time zone. Lists, ranges and steps are allowed; day names and @daily are not. Day of week: 0 is Sunday.`,
    '- "every morning at 9" is "0 9 * * *"; "every hour" is "0 * * * *"; "every 30 minutes" is "*/30 * * * *"; "weekdays at 18:30" is "30 18 * * 1-5"; "every Monday at 10" is "0 10 * * 1".',
    "- Never more often than every 15 minutes.",
    `- allowedTools: only from ${BUILDER_TOOLS.join(", ")}; only the ones the task needs; [] when it needs none.`,
    `- name and summary are in ${language === "uk" ? "Ukrainian" : "English"}. Technical terms stay as they are.`,
    "- The workflow can only read. A request to change, send, post or delete something is rewritten as a report about it.",
    "",
    'When the schedule is missing or vague ("sometimes", "regularly"), do not guess. Answer {"clarify": "<one short question>"} instead.'
  ].join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Checks one model answer; the definition is validated by the same rules as a hand-written one. */
export function readBuilderAnswer(answer: string, options: Pick<BuildOptions, "timezone" | "language" | "newId">): BuildResult {
  const raw = parseJsonObject(answer);
  if (!raw) return { kind: "failed", errors: ["the answer is not a JSON object"] };
  if (typeof raw.clarify === "string" && raw.clarify.trim()) return { kind: "clarify", question: raw.clarify.trim() };
  const tools = Array.isArray(raw.allowedTools) ? raw.allowedTools : [];
  const foreign = tools.filter((tool) => !(BUILDER_TOOLS as readonly unknown[]).includes(tool));
  if (foreign.length > 0) return { kind: "failed", errors: [`allowedTools may only contain ${BUILDER_TOOLS.join(", ")}; got ${foreign.join(", ")}`] };
  const result = validateDefinition({
    id: (options.newId ?? (() => `wf_${randomUUID().slice(0, 8)}`))(),
    name: raw.name,
    schedule: { cron: raw.cron, timezone: options.timezone },
    prompt: raw.prompt,
    allowedTools: tools,
    language: options.language
  });
  if (!result.ok) return { kind: "failed", errors: result.errors };
  const summary = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : result.definition.schedule.cron;
  return { kind: "built", definition: result.definition, summary };
}

/** Text to definition: one model call, and one more with the validator's errors when the first is invalid. */
export async function buildDefinition(text: string, options: BuildOptions): Promise<BuildResult> {
  const system = builderSystemPrompt(options.timezone, options.language);
  let user = text;
  let last: BuildResult = { kind: "no-model" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await options.complete({ system, user });
    if (answer === null) return attempt === 0 ? { kind: "no-model" } : last;
    last = readBuilderAnswer(answer, options);
    if (last.kind !== "failed") return last;
    user = `${text}\n\nYour previous answer was rejected: ${last.errors.join("; ")}. Answer again with a valid JSON object.`;
  }
  return last;
}
