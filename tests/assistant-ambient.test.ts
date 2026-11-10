import { describe, expect, it } from "vitest";

import {
  WIDGET_CARD_HEIGHT,
  WIDGET_VISUAL,
  WIDGET_WIDTH,
  glowFor,
  resolveWidgetPosition,
  widgetCards,
  widgetHeight
} from "../desktop/assistant/ambient.ts";
import type { SessionGroup } from "../desktop/assistant/assistant-state.ts";

describe("glowFor", () => {
  it("lights the frame only while listening or speaking", () => {
    expect(glowFor("listening", false, true)).toBe("listening");
    expect(glowFor("speaking", false, true)).toBe("speaking");
    for (const state of ["idle", "thinking", "working", "waiting", "offline"] as const) {
      expect(glowFor(state, false, true)).toBeNull();
    }
  });

  it("stays off during a call and when disabled", () => {
    expect(glowFor("listening", true, true)).toBeNull();
    expect(glowFor("speaking", false, false)).toBeNull();
  });
});

describe("widgetCards", () => {
  const groups: SessionGroup[] = [
    {
      project: "marshal",
      sessions: [
        { pid: 1, name: "a", status: "waiting", waitingFor: "permission prompt" },
        { pid: 2, name: "b", status: "busy", waitingFor: null }
      ]
    },
    {
      project: "snoriq",
      sessions: [
        { pid: 3, name: "c", status: "waiting", waitingFor: null },
        { pid: 4, name: "d", status: "waiting", waitingFor: null },
        { pid: 5, name: "e", status: "waiting", waitingFor: null }
      ]
    }
  ];

  it("keeps waiting sessions only, at most three", () => {
    expect(widgetCards(groups).map((card) => card.pid)).toEqual([1, 3, 4]);
    expect(widgetCards(groups)[0]).toEqual({ pid: 1, name: "a", waitingFor: "permission prompt" });
  });

  it("grows by one card height per card, capped", () => {
    expect(widgetHeight(0)).toBe(WIDGET_VISUAL);
    expect(widgetHeight(2)).toBe(WIDGET_VISUAL + 2 * WIDGET_CARD_HEIGHT);
    expect(widgetHeight(9)).toBe(widgetHeight(3));
  });
});

describe("resolveWidgetPosition", () => {
  const primary = { x: 0, y: 25, width: 1440, height: 875 };
  const external = { x: 1440, y: 0, width: 1920, height: 1080 };

  it("defaults to the top-right of the primary display", () => {
    expect(resolveWidgetPosition(null, [primary], primary, 112)).toEqual({ x: 1440 - WIDGET_WIDTH - 16, y: 41 });
  });

  it("keeps a saved spot on a second display", () => {
    expect(resolveWidgetPosition({ x: 2000, y: 300 }, [primary, external], primary, 112)).toEqual({ x: 2000, y: 300 });
  });

  it("falls back when the display it was on is gone", () => {
    expect(resolveWidgetPosition({ x: 2000, y: 300 }, [primary], primary, 112)).toEqual({ x: 1440 - WIDGET_WIDTH - 16, y: 41 });
  });

  it("pulls the widget up when cards would push it below the display", () => {
    const height = widgetHeight(3);
    expect(resolveWidgetPosition({ x: 100, y: 850 }, [primary], primary, height)).toEqual({ x: 100, y: 25 + 875 - height });
  });

  it("pulls the widget left off the right edge", () => {
    expect(resolveWidgetPosition({ x: 1400, y: 100 }, [primary], primary, 112)).toEqual({ x: 1440 - WIDGET_WIDTH, y: 100 });
  });
});
