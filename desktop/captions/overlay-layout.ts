// desktop/captions/overlay-layout.ts
//
// Where the captions overlay goes and how it behaves — the decisions that
// do not need Electron and so can be tested. The window class applies them.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayBoundsState {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
}

export const OVERLAY_DEFAULT_WIDTH = 640;
export const OVERLAY_DEFAULT_HEIGHT = 190;
export const OVERLAY_MIN_WIDTH = 320;
export const OVERLAY_MIN_HEIGHT = 96;
/** Gap from the bottom edge when the overlay has never been moved. */
const BOTTOM_MARGIN = 72;

/**
 * Bottom-centre of the work area on first run — where subtitles are expected
 * — and the remembered spot afterwards, pulled back on screen if the display
 * arrangement changed since it was saved.
 */
export function resolveOverlayBounds(state: OverlayBoundsState, workArea: Rect): Rect {
  const width = Math.max(OVERLAY_MIN_WIDTH, Math.min(state.width, workArea.width));
  const height = Math.max(OVERLAY_MIN_HEIGHT, Math.min(state.height, workArea.height));
  const fallbackX = workArea.x + Math.round((workArea.width - width) / 2);
  const fallbackY = workArea.y + workArea.height - height - BOTTOM_MARGIN;
  const x = state.x ?? fallbackX;
  const y = state.y ?? fallbackY;
  return {
    x: clamp(x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(y, workArea.y, workArea.y + workArea.height - height),
    width,
    height
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.round(value), max));
}

export interface OverlayInteractionState {
  /** The drag modifier is held down. */
  modifierHeld: boolean;
  /** The user toggled "move overlay" from the tray. */
  moveModeToggled: boolean;
}

/**
 * The overlay is click-through by default so the call, the editor, the
 * browser underneath keep every click. It accepts the mouse only while the
 * user has asked to move it — by holding the modifier or via the tray
 * toggle for the case where the modifier listener is unavailable.
 */
export function shouldAcceptMouse(state: OverlayInteractionState): boolean {
  return state.modifierHeld || state.moveModeToggled;
}

export type OverlayStatus = "starting" | "listening" | "transcribing" | "summarizing" | "error" | "stopped";

export interface OverlayUpdate {
  status: OverlayStatus;
  /** Recent raw utterances, oldest first. */
  captions: string[];
  /** Rendered HTML for the summary bullets (already escaped). */
  summaryHtml: string;
  /** True while the summary is still streaming. */
  summaryStreaming: boolean;
  /** New transcript arrived and the bullets on screen do not cover it yet. */
  summaryStale: boolean;
  /** Mouse is accepted (drag mode). */
  interactive: boolean;
  /** Short line under the header: provider, hotkey hint, or the error. */
  hint: string;
}
