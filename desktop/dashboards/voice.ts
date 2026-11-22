// Voice entry of the dashboards (#279, stage 3): `./marshal do dashboard …`.
// The dispatcher picks the verb; the words after it are the owner's speech.
// Everything the assistant says comes from here, so it is testable without
// Electron: the service is real, the model and the queries are injected.

import type { MessageKey, MessageParams } from "../i18n/catalog.ts";
import type { DashboardService } from "./dashboard-service.ts";

export const DASHBOARD_VERBS = ["dashboard", "dashboard-refresh", "dashboard-save"] as const;
export type DashboardVerb = (typeof DASHBOARD_VERBS)[number];

export const isDashboardVerb = (verb: string | undefined): verb is DashboardVerb =>
  (DASHBOARD_VERBS as readonly string[]).includes(verb ?? "");

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * The saved template the owner named. Every word of the template's name must
 * be in the speech; the longest name wins, and a tie stays unresolved so the
 * request is built as a new dashboard instead of opening the wrong one.
 */
export function pickTemplate(spoken: string, names: readonly string[]): string | null {
  const said = new Set(words(spoken));
  let best: string | null = null;
  let bestScore = 0;
  let tied = false;
  for (const name of names) {
    const tokens = words(name);
    if (tokens.length === 0 || !tokens.every((token) => said.has(token))) continue;
    const score = tokens.join("").length;
    if (score > bestScore) {
      best = name;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}

export interface VoiceResult {
  /** Said at once. */
  reply: string;
  /** Resolves with what to say when the work ends, or null for nothing more. */
  done?: Promise<string | null>;
}

type Tr = (key: MessageKey, params?: MessageParams) => string;

/** What the service says about a job that just ended: its error, or the given line. */
const outcome = (service: DashboardService, job: Promise<void>, tr: Tr, key: MessageKey): Promise<string | null> =>
  job.then(() => {
    const state = service.state();
    return state.error ?? tr(key, { title: state.dashboard?.title ?? "" });
  });

/**
 * Runs one voice action on a loaded service. `fresh` is true when the window
 * was just opened for this action, so cached charts are refreshed as they
 * would be on a click in the tray.
 */
export async function runDashboardVoice(
  verb: DashboardVerb,
  spoken: string,
  service: DashboardService,
  tr: Tr,
  fresh: boolean
): Promise<VoiceResult> {
  const text = spoken.trim();
  const refresh = (): VoiceResult => {
    if (!service.state().dashboard?.charts.length) return { reply: tr("dash.voice.nothing") };
    const job = service.refresh();
    const error = service.state().error;
    return error ? { reply: error } : { reply: tr("dash.voice.refreshing"), done: outcome(service, job, tr, "dash.voice.refreshed") };
  };

  if (verb === "dashboard-save") {
    const name = await service.saveTemplate();
    return { reply: name ? tr("dash.voice.saved", { title: name }) : (service.state().error ?? tr("dash.voice.nothing")) };
  }

  const template = text === "" ? null : pickTemplate(text, service.state().templates);
  if (template) {
    if (!(await service.openTemplate(template))) return { reply: service.state().error ?? tr("dash.voice.nothing") };
    return refresh();
  }
  if (verb === "dashboard-refresh") return refresh();
  if (text === "") {
    if (fresh) void service.refresh();
    return { reply: tr("dash.voice.opened") };
  }

  const job = service.build(text);
  // build() checks the provider, the folder and a running job before its first await.
  const error = service.state().error;
  return error ? { reply: error } : { reply: tr("dash.voice.building"), done: outcome(service, job, tr, "dash.voice.built") };
}
