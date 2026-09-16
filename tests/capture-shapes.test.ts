// tests/capture-shapes.test.ts
//
// Covers the pure half of the capture annotation editor: font strings, the
// draft guard, shape normalization, the no-op drop rules and the undo stack.
//
// These are the exact rules that let two bugs sit in main unnoticed — text
// drawn at 10px (#132) and phantom "select" shapes (#133) — so they are the
// first thing worth pinning down. See #137.

import { describe, expect, it } from "vitest";

import {
  CANVAS_FONT_STACK,
  canStartDraft,
  counterFontString,
  DRAWABLE_TOOLS,
  HISTORY_LIMIT,
  HistoryStack,
  isNoOpShape,
  normalizeShape,
  SPECIAL_TOOLS,
  textFontSize,
  textFontString,
  textLineHeight
} from "../desktop/renderer/capture-shapes.js";

describe("font strings", () => {
  it("never emits a CSS custom property — canvas rejects the whole declaration", () => {
    // The regression guard for #132: `var(--font-sans)` made ctx.font a no-op,
    // leaving every text annotation at the 10px sans-serif default.
    expect(CANVAS_FONT_STACK).not.toContain("var(");
    expect(textFontString(4)).not.toContain("var(");
    expect(counterFontString(20)).not.toContain("var(");
  });

  it("scales the glyph size with the stroke-width picker", () => {
    expect(textFontSize(2)).toBe(14); // floor
    expect(textFontSize(4)).toBe(24);
    expect(textFontSize(8)).toBe(48);
  });

  it("keeps a floor so the thinnest stroke is still legible", () => {
    expect(textFontSize(1)).toBe(14);
    expect(textLineHeight(1)).toBe(18);
  });

  it("spaces lines further apart than the glyph size", () => {
    for (const width of [2, 4, 8]) {
      expect(textLineHeight(width)).toBeGreaterThan(0);
      expect(textLineHeight(width)).toBeGreaterThanOrEqual(textFontSize(width) * 0.7);
    }
  });

  it("builds a font string the canvas parser accepts", () => {
    expect(textFontString(4)).toBe(`24px ${CANVAS_FONT_STACK}`);
    expect(counterFontString(20)).toBe(`700 22px ${CANVAS_FONT_STACK}`);
  });
});

describe("draft guard", () => {
  it("allows every tool the draw switch can render", () => {
    for (const tool of DRAWABLE_TOOLS) {
      expect(canStartDraft(tool)).toBe(true);
    }
  });

  it("refuses tools that own a dedicated branch", () => {
    for (const tool of SPECIAL_TOOLS) {
      expect(canStartDraft(tool)).toBe(false);
    }
  });

  it("refuses an unknown tool instead of committing an invisible shape", () => {
    // The regression guard for #133: "select" fell through to the draft path
    // and pushed shapes nothing could draw.
    expect(canStartDraft("select")).toBe(false);
    expect(canStartDraft("")).toBe(false);
    expect(canStartDraft(undefined)).toBe(false);
  });

  it("keeps drawable and special tools disjoint", () => {
    for (const tool of DRAWABLE_TOOLS) {
      expect(SPECIAL_TOOLS.has(tool)).toBe(false);
    }
  });
});

describe("normalizeShape", () => {
  it("flips a rectangle dragged up and to the left", () => {
    const shape = normalizeShape({ type: "rect", x: 100, y: 80, w: -40, h: -30 });
    expect(shape).toMatchObject({ x: 60, y: 50, w: 40, h: 30 });
  });

  it("leaves an already positive rectangle alone", () => {
    const shape = normalizeShape({ type: "rect", x: 10, y: 20, w: 30, h: 40 });
    expect(shape).toMatchObject({ x: 10, y: 20, w: 30, h: 40 });
  });

  it("normalizes every rect-like type", () => {
    for (const type of ["rect", "rect-fill", "ellipse", "blur"]) {
      const shape = normalizeShape({ type, x: 50, y: 50, w: -20, h: -10 });
      expect(shape.w, type).toBe(20);
      expect(shape.h, type).toBe(10);
      expect(shape.x, type).toBe(30);
      expect(shape.y, type).toBe(40);
    }
  });

  it("leaves line and pen geometry untouched", () => {
    const line = normalizeShape({ type: "line", x: 90, y: 90, x2: 10, y2: 10 });
    expect(line).toMatchObject({ x: 90, y: 90, x2: 10, y2: 10 });

    const points = [{ x: 3, y: 4 }];
    const pen = normalizeShape({ type: "pen", points });
    expect(pen.points).toEqual(points);
  });

  it("does not mutate the input", () => {
    const original = { type: "rect", x: 100, y: 80, w: -40, h: -30 };
    normalizeShape(original);
    expect(original).toMatchObject({ x: 100, y: 80, w: -40, h: -30 });
  });

  it("preserves style fields", () => {
    const shape = normalizeShape({ type: "rect", x: 0, y: 0, w: -5, h: -5, color: "#abcdef", width: 8 });
    expect(shape.color).toBe("#abcdef");
    expect(shape.width).toBe(8);
  });
});

describe("isNoOpShape", () => {
  it("drops a rectangle thinner than the minimum on either axis", () => {
    expect(isNoOpShape({ type: "rect", x: 0, y: 0, w: 2, h: 100 })).toBe(true);
    expect(isNoOpShape({ type: "rect", x: 0, y: 0, w: 100, h: 2 })).toBe(true);
  });

  it("keeps a rectangle at the threshold", () => {
    expect(isNoOpShape({ type: "rect", x: 0, y: 0, w: 3, h: 3 })).toBe(false);
  });

  it("drops a click that produced no drag", () => {
    expect(isNoOpShape({ type: "rect", x: 10, y: 10, w: 0, h: 0 })).toBe(true);
    expect(isNoOpShape({ type: "line", x: 10, y: 10, x2: 10, y2: 10 })).toBe(true);
  });

  it("drops a line shorter than the minimum length", () => {
    expect(isNoOpShape({ type: "line", x: 0, y: 0, x2: 2, y2: 2 })).toBe(true);
    expect(isNoOpShape({ type: "arrow", x: 0, y: 0, x2: 3, y2: 0 })).toBe(true);
  });

  it("keeps a line past the minimum length", () => {
    expect(isNoOpShape({ type: "line", x: 0, y: 0, x2: 0, y2: 4 })).toBe(false);
    expect(isNoOpShape({ type: "arrow", x: 0, y: 0, x2: 30, y2: 40 })).toBe(false);
  });

  it("drops a pen stroke with too few samples", () => {
    expect(isNoOpShape({ type: "pen", points: [] })).toBe(true);
    expect(isNoOpShape({ type: "pen", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] })).toBe(true);
  });

  it("keeps a pen stroke with enough samples", () => {
    const points = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
    expect(isNoOpShape({ type: "pen", points })).toBe(false);
  });

  it("treats a malformed pen stroke as a no-op rather than throwing", () => {
    expect(isNoOpShape({ type: "pen" })).toBe(true);
  });

  it("never drops a text or counter shape — they carry no extent", () => {
    expect(isNoOpShape({ type: "text", x: 0, y: 0, lines: ["hi"] })).toBe(false);
    expect(isNoOpShape({ type: "counter", x: 0, y: 0, value: 1 })).toBe(false);
  });
});

describe("HistoryStack", () => {
  it("starts with nothing to undo or redo", () => {
    const history = new HistoryStack();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo([])).toBeNull();
    expect(history.redo([])).toBeNull();
  });

  it("walks back to the previous shape list", () => {
    const history = new HistoryStack();
    const empty: unknown[] = [];
    const one = [{ type: "rect" }];

    history.snapshot(empty);
    expect(history.canUndo).toBe(true);
    expect(history.undo(one)).toEqual(empty);
  });

  it("round-trips undo then redo", () => {
    const history = new HistoryStack();
    const empty: unknown[] = [];
    const one = [{ type: "rect", x: 1 }];

    history.snapshot(empty);
    const undone = history.undo(one);
    expect(undone).toEqual(empty);

    expect(history.canRedo).toBe(true);
    expect(history.redo(undone)).toEqual(one);
  });

  it("invalidates the redo path once new work lands", () => {
    const history = new HistoryStack();
    history.snapshot([]);
    history.undo([{ type: "rect" }]);
    expect(history.canRedo).toBe(true);

    history.snapshot([{ type: "arrow" }]);
    expect(history.canRedo).toBe(false);
  });

  it("stores snapshots by value, not by reference", () => {
    const history = new HistoryStack();
    const shapes = [{ type: "rect", x: 1 }];
    history.snapshot(shapes);

    shapes[0].x = 999;
    const restored = history.undo(shapes) as Array<{ x: number }>;
    expect(restored[0].x).toBe(1);
  });

  it("caps the undo depth and drops the oldest entry first", () => {
    const history = new HistoryStack(3);
    for (let i = 0; i < 5; i++) history.snapshot([{ step: i }]);

    expect(history.past).toHaveLength(3);
    expect(history.undo([{ step: 5 }])).toEqual([{ step: 4 }]);
    expect(history.undo([{ step: 4 }])).toEqual([{ step: 3 }]);
    expect(history.undo([{ step: 3 }])).toEqual([{ step: 2 }]);
    expect(history.canUndo).toBe(false);
  });

  it("defaults to the documented depth", () => {
    const history = new HistoryStack();
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) history.snapshot([{ step: i }]);
    expect(history.past).toHaveLength(HISTORY_LIMIT);
  });

  it("clears both stacks on reset, as a crop does", () => {
    const history = new HistoryStack();
    history.snapshot([]);
    history.undo([{ type: "rect" }]);
    expect(history.canUndo || history.canRedo).toBe(true);

    history.reset();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
