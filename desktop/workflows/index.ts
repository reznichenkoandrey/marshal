// Electron side of scheduled workflows (#280), kept out of main.ts.

import path from "node:path";
import { Notification, powerMonitor } from "electron";

import { completeOnce } from "../claude-code/answer-summary.ts";
import { translate, type MessageKey, type MessageParams, type UiLanguage } from "../i18n/catalog.ts";
import { failureKey, WorkflowDelivery, type Presence } from "./delivery.ts";
import { claudeProcess, executeWorkflow } from "./runner.ts";
import { WorkflowScheduler, type WorkflowEvent } from "./scheduler.ts";
import { WorkflowStore } from "./store.ts";
import { workflowVoiceAction, type WorkflowVerb } from "./voice.ts";

export interface WorkflowsHost {
  enabled: () => boolean;
  language: () => UiLanguage;
  presence: () => Promise<Presence>;
  speak: (text: string, key: string) => void;
  /** The home window's "latest" line. */
  line: (text: string) => void;
}

/** Title and body of the notice; a workflow's own language wins over the interface language. */
export function eventText(event: WorkflowEvent, fallback: UiLanguage): { title: string; body: string } {
  const title = event.definition.name;
  if (event.kind === "result") return { title, body: event.result.say };
  return { title, body: translate(event.definition.language ?? fallback, failureKey(event.reason, event.paused)) };
}

export class Workflows {
  private readonly store: WorkflowStore;
  private readonly delivery: WorkflowDelivery;
  private scheduler: WorkflowScheduler | null = null;
  // Electron drops a Notification that nothing references.
  private readonly shown = new Set<Notification>();

  constructor(
    private readonly dir: string,
    private readonly host: WorkflowsHost
  ) {
    this.store = new WorkflowStore(dir);
    this.delivery = new WorkflowDelivery({
      presence: host.presence,
      speak: host.speak,
      line: host.line,
      notify: (title, body) => this.notify(title, body),
      text: (event) => eventText(event, host.language())
    });
    // Timers do not advance while the Mac sleeps; missed runs are settled on wake.
    powerMonitor.on("resume", () => this.scheduler?.rearm());
  }

  /** `claude -p` runs here; the owner's Stop hook from this folder is not a session to announce. */
  get runDir(): string {
    return path.join(this.dir, "run");
  }

  /** Follows the setting: off means no timer, no file read and no process (#281). */
  sync(): void {
    if (!this.host.enabled()) return this.stop();
    if (this.scheduler) return;
    const run = claudeProcess(this.runDir);
    this.scheduler = new WorkflowScheduler(
      this.store,
      (definition) => executeWorkflow(definition, this.store, run),
      Date.now,
      (event) => void this.delivery.deliver(event)
    );
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler?.stop();
    this.scheduler = null;
    this.delivery.stop();
  }

  /** `./marshal do workflow-…`: returns the sentence to say. */
  voice(verb: WorkflowVerb, spoken: string): Promise<string> {
    const language = this.host.language();
    const scheduler = this.scheduler;
    return workflowVoiceAction(verb, spoken, {
      enabled: scheduler !== null,
      t: (key: MessageKey, params?: MessageParams) => translate(language, key, params),
      list: () => this.store.loadDefinitions(Date.now()),
      save: (definition) => this.store.upsertDefinition(definition, Date.now()),
      runNow: (id) => scheduler?.runNow(id) ?? "unknown",
      rearm: () => scheduler?.rearm(),
      unpause: (id) => scheduler?.unpause(id),
      build: {
        complete: ({ system, user }) => completeOnce({ system, user, maxTokens: 600, label: "workflow-builder", timeoutMs: 30_000 }),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language
      }
    });
  }

  private notify(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    const notice = new Notification({ title, body, silent: true });
    this.shown.add(notice);
    const drop = (): void => void this.shown.delete(notice);
    notice.on("click", drop);
    notice.on("close", drop);
    notice.show();
  }
}
