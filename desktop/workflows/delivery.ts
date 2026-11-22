// How a workflow's result reaches the owner (#280): spoken, shown, or held
// until a call ends. The decision is pure; WorkflowDelivery owns the one
// timer that exists only while something is held (#281).

import type { MessageKey } from "../i18n/catalog.ts";
import type { FailureReason } from "./runner.ts";
import type { WorkflowEvent } from "./scheduler.ts";
import type { WorkflowState } from "./store.ts";

export const HOLD_CHECK_MS = 60_000;
export const HOLD_MAX_MS = 60 * 60_000;

export interface Presence {
  asleep: boolean;
  /** A call in another app, a meeting recording or live captions. */
  busy: boolean;
  speechEnabled: boolean;
}

export interface DeliveryPlan {
  speak: boolean;
  notify: boolean;
  /** The home window's "latest" line. */
  line: boolean;
  hold: boolean;
}

/**
 * A quiet run leaves only the journal and the line. A result waits for the
 * call to end; a failure is shown at once but never spoken. Asleep, nothing
 * is spoken.
 */
export function planDelivery(event: Pick<WorkflowEvent, "kind"> & { silent?: boolean }, presence: Presence): DeliveryPlan {
  if (event.kind === "failed") return { speak: false, notify: true, line: true, hold: false };
  if (event.silent) return { speak: false, notify: false, line: true, hold: false };
  if (presence.busy) return { speak: false, notify: false, line: true, hold: true };
  return { speak: presence.speechEnabled && !presence.asleep, notify: true, line: true, hold: false };
}

/** The sentence shown for a failed run; a pause names what the owner has to do. */
export function failureKey(reason: FailureReason, paused: WorkflowState["paused"]): MessageKey {
  if (reason === "auth") return "workflows.failedAuth";
  if (paused === "failing") return "workflows.pausedFailing";
  if (reason === "timeout") return "workflows.failedTimeout";
  if (reason === "missing-binary") return "workflows.failedMissing";
  return "workflows.failed";
}

export interface DeliveryDeps {
  presence: () => Promise<Presence>;
  speak: (text: string, key: string) => void;
  notify: (title: string, body: string) => void;
  line: (text: string) => void;
  /** Title and body of the notice for an event. */
  text: (event: WorkflowEvent) => { title: string; body: string };
  now?: () => number;
}

interface Held {
  event: WorkflowEvent;
  at: number;
}

export class WorkflowDelivery {
  private held: Held[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: DeliveryDeps) {}

  async deliver(event: WorkflowEvent): Promise<void> {
    const presence = await this.deps.presence();
    const plan = planDelivery({ kind: event.kind, silent: event.kind === "result" && event.result.silent }, presence);
    const { title, body } = this.deps.text(event);
    if (plan.line) this.deps.line(`${title}: ${body}`);
    if (plan.hold) return this.hold(event);
    if (plan.notify) this.deps.notify(title, body);
    if (plan.speak) this.deps.speak(body, `workflow:${event.definition.id}`);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.held = [];
  }

  heldCount(): number {
    return this.held.length;
  }

  private hold(event: WorkflowEvent): void {
    // A newer result of the same workflow replaces the one still waiting.
    this.held = this.held.filter((item) => item.event.definition.id !== event.definition.id);
    this.held.push({ event, at: (this.deps.now ?? Date.now)() });
    this.arm();
  }

  private arm(): void {
    if (this.timer || this.held.length === 0) return;
    this.timer = setTimeout(() => void this.release(), HOLD_CHECK_MS);
    this.timer.unref?.();
  }

  private async release(): Promise<void> {
    this.timer = null;
    const now = (this.deps.now ?? Date.now)();
    // After an hour the result is stale; it stays in the journal.
    this.held = this.held.filter((item) => now - item.at < HOLD_MAX_MS);
    if (this.held.length === 0) return;
    const presence = await this.deps.presence();
    if (presence.busy) return this.arm();
    const ready = this.held;
    this.held = [];
    for (const { event } of ready) {
      const { title, body } = this.deps.text(event);
      this.deps.notify(title, body);
      if (presence.speechEnabled && !presence.asleep) this.deps.speak(body, `workflow:${event.definition.id}`);
    }
  }
}
