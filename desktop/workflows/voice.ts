// Voice commands for workflows (#280): `./marshal do workflow-…`. Pure but
// for the injected store, scheduler and model; returns the sentence to say.

import type { MessageKey, MessageParams } from "../i18n/catalog.ts";
import { buildDefinition, type BuildOptions } from "./builder.ts";
import type { WorkflowDefinition } from "./definition.ts";
import type { RunNowResult } from "./scheduler.ts";

export const WORKFLOW_VERBS = ["workflows", "workflow-add", "workflow-run", "workflow-stop", "workflow-start"] as const;
export type WorkflowVerb = (typeof WORKFLOW_VERBS)[number];

export function isWorkflowVerb(verb: string): verb is WorkflowVerb {
  return (WORKFLOW_VERBS as readonly string[]).includes(verb);
}

export interface VoiceDeps {
  enabled: boolean;
  t: (key: MessageKey, params?: MessageParams) => string;
  list: () => WorkflowDefinition[];
  save: (definition: WorkflowDefinition) => void;
  runNow: (id: string) => RunNowResult;
  rearm: () => void;
  unpause: (id: string) => void;
  build: Omit<BuildOptions, "newId">;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Workflows whose name holds every spoken word; an exact name wins over a partial match. */
export function matchWorkflows(definitions: WorkflowDefinition[], spoken: string): WorkflowDefinition[] {
  const wanted = words(spoken);
  if (wanted.length === 0) return [];
  const exact = definitions.filter((definition) => words(definition.name).join(" ") === wanted.join(" "));
  if (exact.length > 0) return exact;
  return definitions.filter((definition) => {
    const name = words(definition.name);
    return wanted.every((word) => name.some((part) => part.startsWith(word) || word.startsWith(part)));
  });
}

export async function workflowVoiceAction(verb: WorkflowVerb, spoken: string, deps: VoiceDeps): Promise<string> {
  const { t } = deps;
  if (!deps.enabled) return t("workflows.off");

  if (verb === "workflows") {
    const definitions = deps.list();
    if (definitions.length === 0) return t("workflows.none");
    const names = definitions.map((definition) => (definition.enabled ? definition.name : t("workflows.listOff", { name: definition.name })));
    return t("workflows.list", { names: names.join(", ") });
  }

  if (verb === "workflow-add") {
    if (!spoken.trim()) return t("workflows.addEmpty");
    const built = await buildDefinition(spoken, deps.build);
    if (built.kind === "no-model") return t("workflows.noModel");
    if (built.kind === "clarify") return built.question;
    if (built.kind === "failed") return t("workflows.buildFailed");
    deps.save(built.definition);
    deps.rearm();
    return t("workflows.created", { name: built.definition.name, summary: built.summary });
  }

  const matches = matchWorkflows(deps.list(), spoken);
  if (matches.length === 0) return t("workflows.notFound");
  if (matches.length > 1) return t("workflows.ambiguous", { names: matches.map((definition) => definition.name).join(", ") });
  const [definition] = matches;
  const name = definition.name;

  if (verb === "workflow-run") {
    const result = deps.runNow(definition.id);
    if (result === "overlap") return t("workflows.busy", { name });
    if (result === "daily-cap") return t("workflows.capped", { name });
    return result === "started" ? t("workflows.started", { name }) : t("workflows.notFound");
  }
  deps.save({ ...definition, enabled: verb === "workflow-start" });
  if (verb === "workflow-start") deps.unpause(definition.id);
  deps.rearm();
  return t(verb === "workflow-start" ? "workflows.enabled" : "workflows.disabled", { name });
}
