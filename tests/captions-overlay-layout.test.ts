import { describe, expect, it } from "vitest";

import {
  OVERLAY_DEFAULT_HEIGHT,
  OVERLAY_DEFAULT_WIDTH,
  OVERLAY_MIN_WIDTH,
  resolveOverlayBounds,
  shouldAcceptMouse
} from "../desktop/captions/overlay-layout.ts";
import { encodeWavPcm16Mono } from "../desktop/captions/wav.ts";

const workArea = { x: 0, y: 25, width: 1440, height: 875 };

describe("resolveOverlayBounds", () => {
  it("sits bottom-centre on first run", () => {
    const bounds = resolveOverlayBounds(
      { x: null, y: null, width: OVERLAY_DEFAULT_WIDTH, height: OVERLAY_DEFAULT_HEIGHT },
      workArea
    );
    expect(bounds.x).toBe((1440 - OVERLAY_DEFAULT_WIDTH) / 2);
    expect(bounds.y + bounds.height).toBeLessThan(workArea.y + workArea.height);
    expect(bounds.y + bounds.height).toBeGreaterThan(workArea.y + workArea.height - 120);
  });

  it("keeps a remembered position but pulls it back on screen", () => {
    const bounds = resolveOverlayBounds({ x: 1400, y: -50, width: 600, height: 180 }, workArea);
    expect(bounds.x).toBe(1440 - 600);
    expect(bounds.y).toBe(workArea.y);
  });

  it("never goes below the minimum size or above the work area", () => {
    const bounds = resolveOverlayBounds({ x: 10, y: 30, width: 50, height: 5000 }, workArea);
    expect(bounds.width).toBe(OVERLAY_MIN_WIDTH);
    expect(bounds.height).toBe(workArea.height);
  });
});

describe("shouldAcceptMouse", () => {
  it("is click-through unless the user is moving the overlay", () => {
    expect(shouldAcceptMouse({ modifierHeld: false, moveModeToggled: false })).toBe(false);
    expect(shouldAcceptMouse({ modifierHeld: true, moveModeToggled: false })).toBe(true);
    expect(shouldAcceptMouse({ modifierHeld: false, moveModeToggled: true })).toBe(true);
  });
});

describe("encodeWavPcm16Mono", () => {
  it("writes a valid 16 kHz mono header around the samples", () => {
    const wav = encodeWavPcm16Mono(new Int16Array([1, -1, 32767]));
    expect(wav.length).toBe(44 + 6);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(6);
    expect(wav.readInt16LE(44)).toBe(1);
    expect(wav.readInt16LE(48)).toBe(32767);
  });
});
