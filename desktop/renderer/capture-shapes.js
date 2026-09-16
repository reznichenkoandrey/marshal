// desktop/renderer/capture-shapes.js
//
// Pure geometry / typography helpers for the capture annotation editor.
//
// These live outside capture-editor.js so they can be unit-tested without an
// Electron window: capture-editor.js touches `window.marshalCapture` and the
// DOM at module scope, which makes it unimportable from vitest. Everything
// here is side-effect free and takes plain objects. See #137.

// Canvas 2D does not resolve CSS custom properties. Assigning a font string
// containing `var(--font-sans)` is rejected outright, silently leaving the
// context at its `10px sans-serif` default — which is exactly how every text
// annotation ended up unreadably small. The stack is therefore spelled out
// literally, kept in sync with `--font-sans` in design-tokens.css so the live
// textarea preview and the rasterized text share a typeface. See #132.
export const CANVAS_FONT_STACK =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif';

/** Shape types `drawShape()` knows how to render via the generic draft path. */
export const DRAWABLE_TOOLS = new Set([
  "rect",
  "rect-fill",
  "ellipse",
  "line",
  "arrow",
  "pen",
  "blur"
]);

/** Tools handled by a dedicated pointerdown branch instead of the draft path. */
export const SPECIAL_TOOLS = new Set(["crop", "text", "counter"]);

/** Rect-like shapes share the x/y/w/h model and the same normalization rules. */
const RECT_LIKE = new Set(["rect", "rect-fill", "ellipse", "blur"]);

/** Minimum width and height, in image pixels, for a rect-like shape to count. */
const MIN_RECT_SIDE = 3;
/** Minimum length, in image pixels, for a line or arrow to count. */
const MIN_LINE_LENGTH = 4;
/** Minimum sample count for a pen stroke to count. */
const MIN_PEN_POINTS = 3;
/** Undo depth. Older entries are dropped once the stack passes this. */
export const HISTORY_LIMIT = 50;

/** Text annotation glyph size, derived from the stroke-width picker. */
export function textFontSize(strokeWidth) {
  return Math.max(14, strokeWidth * 6);
}

/** Baseline-to-baseline distance for multi-line text annotations. */
export function textLineHeight(strokeWidth) {
  return Math.max(18, strokeWidth * 7);
}

/** Canvas font string for a text annotation at the given stroke width. */
export function textFontString(strokeWidth) {
  return `${textFontSize(strokeWidth)}px ${CANVAS_FONT_STACK}`;
}

/** Canvas font string for the number inside a counter bubble of radius `r`. */
export function counterFontString(radius) {
  return `700 ${Math.round(radius * 1.1)}px ${CANVAS_FONT_STACK}`;
}

/**
 * True when the tool can produce a shape through the generic draft path.
 * A tool that is neither drawable nor special-cased must not start a draft:
 * it would commit a shape `drawShape()` cannot render, so the user would see
 * nothing while the undo stack silently grew. See #133.
 */
export function canStartDraft(tool) {
  return DRAWABLE_TOOLS.has(tool);
}

/**
 * Flips negative width/height so rect-like shapes always have a top-left
 * origin and positive extents. Returns a new object; the input is untouched.
 */
export function normalizeShape(shape) {
  if (!RECT_LIKE.has(shape.type)) return { ...shape };

  const out = { ...shape };
  if (out.w < 0) {
    out.x += out.w;
    out.w = -out.w;
  }
  if (out.h < 0) {
    out.y += out.h;
    out.h = -out.h;
  }
  return out;
}

/**
 * True for shapes too small to be intentional — a stray click or a twitch
 * while reaching for another tool. Callers drop these instead of committing
 * them, so the undo stack only holds things the user can actually see.
 *
 * Expects an already-normalized shape for the rect-like types.
 */
export function isNoOpShape(shape) {
  if (RECT_LIKE.has(shape.type)) {
    return Math.abs(shape.w) < MIN_RECT_SIDE || Math.abs(shape.h) < MIN_RECT_SIDE;
  }
  if (shape.type === "line" || shape.type === "arrow") {
    return Math.hypot(shape.x2 - shape.x, shape.y2 - shape.y) < MIN_LINE_LENGTH;
  }
  if (shape.type === "pen") {
    return !Array.isArray(shape.points) || shape.points.length < MIN_PEN_POINTS;
  }
  return false;
}

/**
 * Undo/redo stack over JSON snapshots of the shape array.
 *
 * Snapshots rather than inverse operations: the shape list is small and flat,
 * and a snapshot cannot drift out of sync with the model the way a hand-written
 * inverse can. Capped at HISTORY_LIMIT so a long session cannot grow unbounded.
 */
export class HistoryStack {
  constructor(limit = HISTORY_LIMIT) {
    this.limit = limit;
    this.past = [];
    this.future = [];
  }

  /** Records the current state as an undo point and invalidates the redo path. */
  snapshot(shapes) {
    this.past.push(JSON.stringify(shapes));
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  /** Returns the previous shape array, or null when there is nothing to undo. */
  undo(currentShapes) {
    if (this.past.length === 0) return null;
    this.future.push(JSON.stringify(currentShapes));
    return JSON.parse(this.past.pop());
  }

  /** Returns the re-applied shape array, or null when there is nothing to redo. */
  redo(currentShapes) {
    if (this.future.length === 0) return null;
    this.past.push(JSON.stringify(currentShapes));
    return JSON.parse(this.future.pop());
  }

  /** Drops both stacks — used after a crop bakes annotations into the base. */
  reset() {
    this.past.length = 0;
    this.future.length = 0;
  }
}

// ── Zoom geometry ───────────────────────────────────────────────────────────
//
// The editor presents the capture at a CSS size derived from the zoom, while
// the canvas element attributes stay in native image pixels. Sizing the layout
// box (rather than applying a CSS transform to a full-size box) is what keeps
// the capture inside the viewport: a transform leaves the layout box at image
// size, and the viewport's flex centering then pushes a 3600px-wide box far
// off-screen. See #139.

/** Smallest zoom the UI allows. Below this the capture is unusable. */
export const MIN_ZOOM = 0.1;
/** Largest zoom the UI allows. */
export const MAX_ZOOM = 4;
/** Breathing room, in CSS pixels, left around the capture when fitting. */
export const FIT_PADDING = 32;

/** Presented CSS size of the capture at a given zoom. Always at least 1px. */
export function zoomedSize(baseWidth, baseHeight, zoom) {
  return {
    width: Math.max(1, Math.round(baseWidth * zoom)),
    height: Math.max(1, Math.round(baseHeight * zoom))
  };
}

/**
 * Zoom that fits the capture inside the viewport, never magnifying past 1:1.
 * Returns null when the inputs cannot produce a meaningful fit, so callers
 * can leave the current zoom alone rather than collapse the canvas.
 */
export function computeFitZoom(viewportWidth, viewportHeight, baseWidth, baseHeight, padding = FIT_PADDING) {
  if (baseWidth <= 0 || baseHeight <= 0) return null;

  const availableWidth = viewportWidth - padding;
  const availableHeight = viewportHeight - padding;
  if (availableWidth <= 0 || availableHeight <= 0) return null;

  const fit = Math.min(availableWidth / baseWidth, availableHeight / baseHeight, 1);
  return clampZoom(fit);
}

/** Keeps a zoom inside the range the toolbar and fit logic agree on. */
export function clampZoom(zoom) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}
