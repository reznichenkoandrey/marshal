// desktop/captions/summary-policy.ts
//
// What happens when new transcript arrives while a summary is still
// streaming (V2 spec §2.4, "queue or interrupt"). Pure, so the rule is
// tested without the service.

export type TurnPolicy = "interrupt" | "queue";

export type SummaryAction =
  /** Nothing in flight: start a request now. */
  | "start"
  /** Abort the in-flight request and start over with the fuller transcript. */
  | "restart"
  /** Let the in-flight request finish, then run once more with everything that arrived. */
  | "queue";

export interface SummaryPolicyContext {
  policy: TurnPolicy;
  streaming: boolean;
}

/**
 * `interrupt` favours freshness: the bullets on screen always describe the
 * latest words, at the cost of a wasted partial request. `queue` favours
 * stability: the current bullets finish, and one follow-up request covers
 * everything that came in meanwhile — never one request per segment.
 */
export function decideSummaryAction(context: SummaryPolicyContext): SummaryAction {
  if (!context.streaming) return "start";
  return context.policy === "queue" ? "queue" : "restart";
}
