import { describe, expect, it } from "vitest";

import {
  DEFAULT_CALIBRATION,
  calibrate,
  cosineSimilarity,
  decideSpeaker,
  initialFeedback,
  isBackgroundLevel,
  noteOwnerCommand,
  noteRejection,
  percentile,
  type Calibration,
} from "../desktop/assistant/speaker/calibration.ts";

/** Evenly spread synthetic scores in [from, to]. */
const spread = (from: number, to: number, count: number) =>
  Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));

const OWNER = spread(0.6, 0.9, 40);
const FOREIGN = spread(0.05, 0.4, 40);
const READY = calibrate(OWNER, FOREIGN);

describe("cosineSimilarity", () => {
  it("scores identical, opposite and orthogonal vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns null for vectors that cannot be compared", () => {
    expect(cosineSimilarity([], [])).toBeNull();
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBeNull();
    expect(cosineSimilarity([0, 0], [1, 2])).toBeNull();
    expect(cosineSimilarity([Number.NaN, 1], [1, 1])).toBeNull();
  });
});

describe("percentile", () => {
  it("interpolates and does not depend on input order", () => {
    expect(percentile([4, 1, 3, 2], 50)).toBeCloseTo(2.5);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([7], 5)).toBe(7);
    expect(percentile([], 5)).toBeNull();
  });
});

describe("calibrate", () => {
  it("keeps collecting until both sides have enough samples", () => {
    expect(calibrate(OWNER.slice(0, 5), FOREIGN)).toEqual({ status: "collecting", ownerSamples: 5, foreignSamples: 40 });
    expect(calibrate(OWNER, [])).toEqual({ status: "collecting", ownerSamples: 40, foreignSamples: 0 });
  });

  it("puts the threshold a margin below the owner's low percentile", () => {
    expect(READY.status).toBe("ready");
    if (READY.status !== "ready") return;
    expect(READY.threshold).toBeCloseTo(percentile(OWNER, 5)! - DEFAULT_CALIBRATION.margin);
    expect(READY.falseRejectRate).toBe(0);
    expect(READY.falseAcceptRate).toBe(0);
    expect(READY.optimistic).toBe(false);
  });

  it("reads percentile and margin from params, not constants", () => {
    const loose = calibrate(OWNER, FOREIGN, { params: { ...DEFAULT_CALIBRATION, ownerPercentile: 50, margin: 0 } });
    expect(loose.status === "ready" && loose.threshold).toBeCloseTo(0.75);
    expect(loose.status === "ready" && loose.falseRejectRate).toBeCloseTo(0.5);
  });

  it("refuses a threshold that lets foreign voices through", () => {
    const overlapping = calibrate(OWNER, spread(0.3, 0.8, 40));
    expect(overlapping.status).toBe("unusable");
    expect(overlapping.status === "unusable" && overlapping.falseAcceptRate).toBeGreaterThan(0.02);
  });

  it("marks a calibration against synthetic voices as optimistic", () => {
    const seeded = calibrate(OWNER, FOREIGN, { foreignSynthetic: true });
    expect(seeded.status === "ready" && seeded.optimistic).toBe(true);
  });

  it("ignores scores that are not numbers", () => {
    const withJunk = calibrate([...OWNER, Number.NaN], [...FOREIGN, Number.POSITIVE_INFINITY]);
    expect(withJunk).toEqual(READY);
  });
});

describe("isBackgroundLevel", () => {
  const usual = Array<number>(12).fill(-25);

  it("drops speech far below the owner's usual level", () => {
    expect(isBackgroundLevel(-45, usual)).toBe(true);
    expect(isBackgroundLevel(-35, usual)).toBe(false);
  });

  it("stays out of the way until the usual level is known", () => {
    expect(isBackgroundLevel(-70, usual.slice(0, 3))).toBe(false);
    expect(isBackgroundLevel(Number.NaN, usual)).toBe(false);
  });
});

describe("decideSpeaker", () => {
  it("accepts the owner and rejects a foreign voice", () => {
    expect(decideSpeaker({ score: 0.8 }, READY)).toEqual({ verdict: "accept", reason: "owner" });
    expect(decideSpeaker({ score: 0.2 }, READY)).toEqual({ verdict: "reject", reason: "not-owner" });
  });

  it("lets the command through when the check cannot run", () => {
    expect(decideSpeaker({ score: null }, READY)).toEqual({ verdict: "accept", reason: "unavailable" });
    expect(decideSpeaker({ score: Number.NaN }, READY)).toEqual({ verdict: "accept", reason: "unavailable" });
  });

  it("does not gate anything before a usable calibration exists", () => {
    const collecting: Calibration = { status: "collecting", ownerSamples: 3, foreignSamples: 0 };
    expect(decideSpeaker({ score: 0.1 }, collecting)).toEqual({ verdict: "accept", reason: "not-calibrated" });
    expect(decideSpeaker({ score: 0.1 }, calibrate(OWNER, spread(0.3, 0.8, 40)))).toEqual({
      verdict: "accept",
      reason: "not-calibrated",
    });
  });

  it("drops a quiet clip even when the voice matches", () => {
    const ownerLevelsDb = Array<number>(12).fill(-25);
    expect(decideSpeaker({ score: 0.85, levelDb: -50 }, READY, { ownerLevelsDb })).toEqual({
      verdict: "reject",
      reason: "background",
    });
    expect(decideSpeaker({ score: 0.85, levelDb: -28 }, READY, { ownerLevelsDb }).verdict).toBe("accept");
  });

  it("uses the threshold lowered by feedback", () => {
    expect(READY.status).toBe("ready");
    if (READY.status !== "ready") return;
    const score = READY.threshold - 0.01;
    expect(decideSpeaker({ score }, READY).verdict).toBe("reject");
    expect(decideSpeaker({ score }, READY, { threshold: READY.threshold - 0.02 }).verdict).toBe("accept");
  });
});

describe("feedback", () => {
  const start = initialFeedback(0.6);

  it("lowers the threshold when the owner re-sends right after a rejection", () => {
    const result = noteOwnerCommand(noteRejection(start, 1000), 9000);
    expect(result.lowered).toBe(true);
    expect(result.relearn).toBe(false);
    expect(result.state.threshold).toBeCloseTo(0.58);
    expect(result.state.lastRejectionAtMs).toBeNull();
  });

  it("ignores an owner command with no recent rejection", () => {
    expect(noteOwnerCommand(start, 5000).lowered).toBe(false);
    expect(noteOwnerCommand(noteRejection(start, 1000), 17_000).lowered).toBe(false);
  });

  it("counts one rejection once", () => {
    const first = noteOwnerCommand(noteRejection(start, 1000), 2000);
    const second = noteOwnerCommand(first.state, 3000);
    expect(second.lowered).toBe(false);
    expect(second.state.threshold).toBeCloseTo(0.58);
  });

  it("never moves on rejections alone", () => {
    const state = noteRejection(noteRejection(noteRejection(start, 1000), 2000), 3000);
    expect(state.threshold).toBe(0.6);
    expect(state.wrongfulAtMs).toEqual([]);
  });

  it("stops at the drift floor and asks for re-learning after repeated wrongful rejections", () => {
    let state = start;
    let relearn = false;
    for (let i = 0; i < 8; i += 1) {
      const at = i * 60_000;
      const result = noteOwnerCommand(noteRejection(state, at), at + 5000);
      state = result.state;
      relearn = result.relearn;
      if (i === 1) expect(relearn).toBe(false);
      if (i === 2) expect(relearn).toBe(true);
    }
    expect(relearn).toBe(true);
    expect(state.threshold).toBeCloseTo(0.5);
  });

  it("forgets wrongful rejections older than the re-learn window", () => {
    const week = DEFAULT_CALIBRATION.relearnWindowMs;
    let state = start;
    for (const at of [0, week + 60_000, 2 * week + 120_000]) {
      const result = noteOwnerCommand(noteRejection(state, at), at + 1000);
      state = result.state;
      expect(result.relearn).toBe(false);
    }
    expect(state.wrongfulAtMs).toHaveLength(1);
  });
});
