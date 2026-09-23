// desktop/captions/partial-policy.ts
//
// Rolling partial captions (#203): while somebody is still talking, the open
// utterance is transcribed every so often and shown as a live, provisional
// line — instead of the overlay staying empty until the phrase closes, which
// with a 9 s segment cap meant up to nine seconds of nothing.
//
// The partial pass is strictly subordinate to the final one, and every rule
// here exists to keep it that way:
//
//   - It never enters the transcript buffer and never schedules a summary.
//     A summary reacting to half a sentence would undo the turn policy (#189).
//   - It never competes with a final: it does not start while a final is
//     queued or being transcribed.
//   - It never falls back to the local model. `hybrid` answers a Groq 429 by
//     running whisper.cpp; a partial that tripped the rate limit would drag
//     the *finals* onto the slow local path too. Partials therefore go
//     straight to Groq, and the first failure switches them off for a while.
//
// Pure, so the rules are tested without the service.

import type { BackendName } from "../dictation/whisper-backend.ts";

/**
 * Speech between two partial passes. 1000 ms tripped the Groq rate limit
 * within seconds on a real call (#207); with the 3 s window that is now the
 * most a pass sends, 1500 ms costs ~2 s of audio per second of speech.
 */
export const DEFAULT_PARTIAL_INTERVAL_MS = 1_500;
/** Floor for the env override — below this the requests only queue up behind each other. */
export const MIN_PARTIAL_INTERVAL_MS = 500;
/**
 * How long partials stay off after a failed pass. A rate limit is the likely
 * cause, and the quota it protects is the one the final captions live on.
 */
export const PARTIAL_COOLDOWN_MS = 60_000;
/** Bounds for a cool-down taken from the provider's own "try again in" hint. */
export const MIN_PARTIAL_COOLDOWN_MS = 5_000;
export const MAX_PARTIAL_COOLDOWN_MS = 10 * 60_000;

const RETRY_HINT = /try again in\s+([\d.hms]+)/iu;
const RETRY_PART = /(\d+(?:\.\d+)?)(ms|h|m|s)/gu;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * The cool-down a rate-limit error asks for, from Groq's "Please try again in
 * 1m3.5s" wording. A fixed minute was both too short for an hourly audio
 * limit and too long for a per-minute one; the provider knows which it is.
 * Returns null when the message carries no hint, so the caller keeps its
 * default. Clamped: a hint of hours still re-checks within ten minutes.
 */
export function parseRetryAfterMs(message: string): number | null {
  const hint = RETRY_HINT.exec(message)?.[1]?.replace(/\.$/u, "");
  if (!hint) return null;
  let total = 0;
  let matched = false;
  for (const [, value, unit] of hint.matchAll(RETRY_PART)) {
    total += Number.parseFloat(value) * UNIT_MS[unit];
    matched = true;
  }
  if (!matched || !Number.isFinite(total)) return null;
  return Math.min(Math.max(Math.ceil(total), MIN_PARTIAL_COOLDOWN_MS), MAX_PARTIAL_COOLDOWN_MS);
}

/**
 * Which STT backend the partial pass uses, or null when partials are off.
 *
 * On by default on every backend. The local one used to be excluded because
 * each whisper-cli call cost 1.6 s of model loading and two of them in flight
 * slowed a final to 11 s (#219); with the model resident (#218) a partial
 * costs ~0.6 s and queues behind a final instead of fighting it. `0` turns
 * partials off; `1` is accepted for compatibility and means the default.
 * `hybrid` maps to plain `groq`: a rate-limited partial must fail, not drag
 * the finals onto the local fallback with it.
 */
export function resolvePartialBackend(raw: string | undefined, captionsBackend: BackendName): BackendName | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "0" || value === "off" || value === "false") return null;
  return captionsBackend === "whisper-cpp" ? "whisper-cpp" : "groq";
}

export function resolvePartialIntervalMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PARTIAL_INTERVAL_MS;
  return Math.max(parsed, MIN_PARTIAL_INTERVAL_MS);
}

/**
 * Admission control for partial passes: at most one in flight, none while a
 * final is pending, none during the cool-down after a failure.
 */
export class PartialGate {
  private inFlight = false;
  private disabledUntil = 0;

  constructor(private readonly cooldownMs = PARTIAL_COOLDOWN_MS) {}

  /** Claims the slot. Returns false when the pass should be skipped. */
  tryBegin(now: number, finalsPending: boolean): boolean {
    if (this.inFlight || finalsPending || now < this.disabledUntil) return false;
    this.inFlight = true;
    return true;
  }

  /**
   * Releases the slot; a failed pass starts the cool-down — the provider's
   * own figure when it gave one, the default otherwise.
   */
  end(ok: boolean, now: number, cooldownMs: number | null = null): void {
    this.inFlight = false;
    if (!ok) this.disabledUntil = now + (cooldownMs ?? this.cooldownMs);
  }

  /** True while partials are switched off after a failure. */
  isCoolingDown(now: number): boolean {
    return now < this.disabledUntil;
  }

  reset(): void {
    this.inFlight = false;
    this.disabledUntil = 0;
  }
}

/**
 * Whether a partial result still describes an open utterance. Transcription
 * is asynchronous, so a partial can land after the final for the same
 * utterance — at which point showing it would replace a finished caption with
 * an older, rougher guess of it.
 */
export function isPartialCurrent(utteranceId: number, lastFinalUtteranceId: number): boolean {
  return utteranceId > lastFinalUtteranceId;
}
