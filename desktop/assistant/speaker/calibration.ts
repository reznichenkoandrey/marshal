// Speaker check (#287), stage S0: thresholds, the accept/reject decision, the quiet-voice
// filter and the feedback rule. Pure logic: no model, no audio, no Electron.
// Spec: docs/SPEAKER_CHECK.md.

export interface CalibrationParams {
  /** Low percentile (0–100) of the owner's own scores the threshold starts from. */
  ownerPercentile: number;
  /** Subtracted from that percentile, so a slightly-off day still passes. */
  margin: number;
  minOwnerSamples: number;
  minForeignSamples: number;
  /** The threshold is usable only if it rejects at least this share of foreign samples. */
  minForeignRejectRate: number;
  /** Speech this many dB below the owner's usual level is background. */
  quietBelowDb: number;
  /** Levels needed before the quiet filter trusts "the owner's usual level". */
  minLevelSamples: number;
  /** A proven owner command this soon after a rejection marks the rejection as wrongful. */
  resendWindowMs: number;
  /** How far one wrongful rejection lowers the threshold. */
  feedbackStep: number;
  /** The threshold never drifts further than this below its calibrated value. */
  maxFeedbackDrift: number;
  /** This many wrongful rejections inside `relearnWindowMs` ask for re-learning. */
  relearnAfter: number;
  relearnWindowMs: number;
}

export const DEFAULT_CALIBRATION: CalibrationParams = {
  ownerPercentile: 5,
  margin: 0.05,
  minOwnerSamples: 20,
  minForeignSamples: 10,
  minForeignRejectRate: 0.98,
  quietBelowDb: 15,
  minLevelSamples: 10,
  resendWindowMs: 15_000,
  feedbackStep: 0.02,
  maxFeedbackDrift: 0.1,
  relearnAfter: 3,
  relearnWindowMs: 7 * 24 * 60 * 60 * 1000,
};

/** Cosine similarity of two embeddings; null when they cannot be compared. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const score = dot / Math.sqrt(normA * normB);
  return Number.isFinite(score) ? score : null;
}

/** Linear-interpolated percentile (p in 0–100); null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

export type Calibration =
  | { status: "collecting"; ownerSamples: number; foreignSamples: number }
  | {
      /** `unusable`: owner and foreign scores overlap too much for this threshold to gate anything. */
      status: "ready" | "unusable";
      threshold: number;
      /** Share of the owner's samples the threshold would reject. */
      falseRejectRate: number;
      /** Share of foreign samples the threshold would accept. */
      falseAcceptRate: number;
      ownerSamples: number;
      foreignSamples: number;
      /** Foreign side is synthetic TTS: clean audio, so the rates are optimistic for a real room. */
      optimistic: boolean;
    };

/** Threshold = low percentile of the owner's scores minus a margin, kept only if it rejects most foreign samples. */
export function calibrate(
  ownerScores: readonly number[],
  foreignScores: readonly number[],
  options: { foreignSynthetic?: boolean; params?: CalibrationParams } = {},
): Calibration {
  const params = options.params ?? DEFAULT_CALIBRATION;
  const owner = ownerScores.filter(Number.isFinite);
  const foreign = foreignScores.filter(Number.isFinite);
  const base = percentile(owner, params.ownerPercentile);
  if (base === null || owner.length < params.minOwnerSamples || foreign.length < params.minForeignSamples) {
    return { status: "collecting", ownerSamples: owner.length, foreignSamples: foreign.length };
  }
  const threshold = base - params.margin;
  const falseRejectRate = owner.filter((score) => score < threshold).length / owner.length;
  const falseAcceptRate = foreign.filter((score) => score >= threshold).length / foreign.length;
  return {
    status: 1 - falseAcceptRate >= params.minForeignRejectRate ? "ready" : "unusable",
    threshold,
    falseRejectRate,
    falseAcceptRate,
    ownerSamples: owner.length,
    foreignSamples: foreign.length,
    optimistic: options.foreignSynthetic === true,
  };
}

/** True when the clip is far quieter than the owner usually speaks (a TV in the next room, a far voice). */
export function isBackgroundLevel(
  levelDb: number,
  ownerLevelsDb: readonly number[],
  params: CalibrationParams = DEFAULT_CALIBRATION,
): boolean {
  if (!Number.isFinite(levelDb) || ownerLevelsDb.length < params.minLevelSamples) return false;
  const usual = percentile(ownerLevelsDb, 50)!;
  return levelDb < usual - params.quietBelowDb;
}

export interface SpeakerDecision {
  verdict: "accept" | "reject";
  /**
   * `unavailable` and `not-calibrated` accept: a check that cannot run must never silently
   * drop the owner's command. The caller logs these.
   */
  reason: "owner" | "not-owner" | "background" | "unavailable" | "not-calibrated";
}

export interface SpeakerSample {
  /** Similarity to the owner's profile; null when the model or the clip was unavailable. */
  score: number | null;
  /** Clip level in dBFS, when the helper reports one. */
  levelDb?: number;
}

export function decideSpeaker(
  sample: SpeakerSample,
  calibration: Calibration,
  options: { threshold?: number; ownerLevelsDb?: readonly number[]; params?: CalibrationParams } = {},
): SpeakerDecision {
  if (sample.score === null || !Number.isFinite(sample.score)) return { verdict: "accept", reason: "unavailable" };
  if (calibration.status !== "ready") return { verdict: "accept", reason: "not-calibrated" };
  if (sample.levelDb !== undefined && isBackgroundLevel(sample.levelDb, options.ownerLevelsDb ?? [], options.params)) {
    return { verdict: "reject", reason: "background" };
  }
  const threshold = options.threshold ?? calibration.threshold;
  return sample.score >= threshold ? { verdict: "accept", reason: "owner" } : { verdict: "reject", reason: "not-owner" };
}

export interface FeedbackState {
  /** Threshold in force: the calibrated one, lowered by feedback. */
  threshold: number;
  calibratedThreshold: number;
  lastRejectionAtMs: number | null;
  wrongfulAtMs: number[];
}

export function initialFeedback(calibratedThreshold: number): FeedbackState {
  return { threshold: calibratedThreshold, calibratedThreshold, lastRejectionAtMs: null, wrongfulAtMs: [] };
}

export function noteRejection(state: FeedbackState, atMs: number): FeedbackState {
  return { ...state, lastRejectionAtMs: atMs };
}

/**
 * A command proven to be the owner's (a key press, or a voice the check accepted) right after
 * a rejection means the rejection was wrong: lower the threshold one step. A rejection followed
 * only by more rejections proves nothing, so a TV repeating the name never moves the threshold.
 */
export function noteOwnerCommand(
  state: FeedbackState,
  atMs: number,
  params: CalibrationParams = DEFAULT_CALIBRATION,
): { state: FeedbackState; lowered: boolean; relearn: boolean } {
  const rejectedAt = state.lastRejectionAtMs;
  if (rejectedAt === null || atMs < rejectedAt || atMs - rejectedAt > params.resendWindowMs) {
    return { state: { ...state, lastRejectionAtMs: null }, lowered: false, relearn: false };
  }
  const wrongfulAtMs = [...state.wrongfulAtMs, atMs].filter((at) => atMs - at <= params.relearnWindowMs);
  const threshold = Math.max(state.calibratedThreshold - params.maxFeedbackDrift, state.threshold - params.feedbackStep);
  return {
    state: { ...state, threshold, lastRejectionAtMs: null, wrongfulAtMs },
    lowered: threshold < state.threshold,
    relearn: wrongfulAtMs.length >= params.relearnAfter,
  };
}
