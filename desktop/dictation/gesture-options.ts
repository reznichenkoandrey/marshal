export type DictationGestureOptions = {
  holdDelayMs: number;
  toggleTapCount: number;
  toggleTapThresholdMs: number;
  /**
   * Record from the key press, not after holdDelayMs: the first words are not lost (#522).
   * A release before holdDelayMs is then a cancel, so taps keep their meaning.
   */
  startOnPress?: boolean;
};

export const DEFAULT_HOLD_DELAY_MS = 200;
export const DEFAULT_TOGGLE_TAP_COUNT = 0;
export const DEFAULT_TOGGLE_TAP_THRESHOLD_MS = 350;

export function clampInteger(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function normalizeToggleTapCount(raw: unknown, fallback = DEFAULT_TOGGLE_TAP_COUNT): number {
  const parsed = clampInteger(raw, fallback, 0, 3);
  return parsed === 1 ? fallback : parsed;
}
