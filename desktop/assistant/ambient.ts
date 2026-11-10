// Ambient indicators (#285): the glow frame along the screen edges and the
// mini widget. Pure rules only, so what shows when — and where the widget
// lands on a changed display layout — is testable without Electron.

import type { AssistantState, SessionGroup } from "./assistant-state.ts";

export type GlowState = "listening" | "speaking";

/**
 * The frame says "the mic is hot" or "Marshal is talking" and nothing else.
 * It stays off during a call: recording a meeting or running captions is the
 * call signal until presence detection (#267) exists.
 */
export function glowFor(state: AssistantState, inCall: boolean, enabled: boolean): GlowState | null {
  if (!enabled || inCall) return null;
  return state === "listening" || state === "speaking" ? state : null;
}

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

// Mirrors .visual and .card in assistant-widget.css (#338).
export const WIDGET_WIDTH = 168;
export const WIDGET_VISUAL = 72;
export const WIDGET_CARD_HEIGHT = 40;
export const WIDGET_MAX_CARDS = 3;
const WIDGET_MARGIN = 16;

export type WidgetCard = { pid: number; name: string; waitingFor: string | null };

/** "Session X needs you" cards: only sessions that wait, at most three. */
export function widgetCards(groups: readonly SessionGroup[]): WidgetCard[] {
  return groups
    .flatMap((group) => group.sessions)
    .filter((session) => session.status === "waiting")
    .slice(0, WIDGET_MAX_CARDS)
    .map(({ pid, name, waitingFor }) => ({ pid, name, waitingFor }));
}

export function widgetHeight(cardCount: number): number {
  return WIDGET_VISUAL + Math.min(cardCount, WIDGET_MAX_CARDS) * WIDGET_CARD_HEIGHT;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/**
 * The saved spot, pulled fully inside the display it is on (cards grow the
 * widget downwards). A spot on no display — an unplugged monitor — falls back
 * to the top-right corner of the primary one: off-screen, an LSUIElement app
 * has no way back (#168).
 */
export function resolveWidgetPosition(
  saved: Point | null,
  workAreas: readonly Rect[],
  primary: Rect,
  height: number
): Point {
  const area = saved && workAreas.find((candidate) =>
    saved.x >= candidate.x &&
    saved.y >= candidate.y &&
    saved.x < candidate.x + candidate.width &&
    saved.y < candidate.y + candidate.height
  );
  if (saved && area) {
    return {
      x: clamp(saved.x, area.x, area.x + area.width - WIDGET_WIDTH),
      y: clamp(saved.y, area.y, area.y + area.height - height)
    };
  }
  return { x: primary.x + primary.width - WIDGET_WIDTH - WIDGET_MARGIN, y: primary.y + WIDGET_MARGIN };
}
