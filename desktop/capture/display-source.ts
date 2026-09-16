// desktop/capture/display-source.ts
//
// Matching a desktopCapturer source to the display it belongs to.
//
// Kept free of any `electron` import so it can be unit-tested directly — the
// runtime wiring lives in display-capture.ts. The rule this encodes is small
// but was the second half of #136: `sources[0]` is not the display you asked
// about. desktopCapturer returns one source per screen in an unspecified
// order, so the only honest way to find a display's source is by `display_id`.

/** Minimal shape of a desktopCapturer screen source. */
export interface ScreenSourceLike {
  /** Electron reports this as a string even though Display.id is a number. */
  display_id: string;
  name?: string;
}

/**
 * Finds the capturer source belonging to `displayId`.
 *
 * Returns null when nothing matches, so callers decide whether to fall back
 * or fail loudly. Silently handing back a different monitor than the user
 * asked for is worse than either.
 */
export function pickSourceForDisplay<T extends ScreenSourceLike>(
  sources: readonly T[],
  displayId: number | string
): T | null {
  const wanted = String(displayId);
  return sources.find((source) => source.display_id === wanted) ?? null;
}
