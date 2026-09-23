// tests/captions-partial-policy.test.ts
//
// Admission rules for live partial captions (#203). These are what keep the
// partial pass from hurting the final one — never competing with a final,
// never falling back to the local model, backing off after a failure — so
// they are pinned here rather than trusted to the service.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PARTIAL_INTERVAL_MS,
  isPartialCurrent,
  MIN_PARTIAL_INTERVAL_MS,
  PartialGate,
  resolvePartialBackend,
  resolvePartialIntervalMs
} from "../desktop/captions/partial-policy.ts";

describe("resolvePartialBackend", () => {
  it("is on for remote STT and off for the local model by default", () => {
    expect(resolvePartialBackend(undefined, "groq")).toBe("groq");
    expect(resolvePartialBackend(undefined, "hybrid")).toBe("groq");
    expect(resolvePartialBackend(undefined, "whisper-cpp")).toBeNull();
  });

  it("never gives hybrid its local fallback", () => {
    // A rate-limited partial must fail, not drag everything onto whisper.cpp.
    expect(resolvePartialBackend("1", "hybrid")).toBe("groq");
  });

  it("can be forced on for the local model and off everywhere", () => {
    expect(resolvePartialBackend("1", "whisper-cpp")).toBe("whisper-cpp");
    expect(resolvePartialBackend("0", "groq")).toBeNull();
    expect(resolvePartialBackend("off", "hybrid")).toBeNull();
  });
});

describe("resolvePartialIntervalMs", () => {
  it("defaults when unset or malformed", () => {
    expect(resolvePartialIntervalMs(undefined)).toBe(DEFAULT_PARTIAL_INTERVAL_MS);
    expect(resolvePartialIntervalMs("soon")).toBe(DEFAULT_PARTIAL_INTERVAL_MS);
  });

  it("clamps to the floor", () => {
    expect(resolvePartialIntervalMs("50")).toBe(MIN_PARTIAL_INTERVAL_MS);
    expect(resolvePartialIntervalMs("1500")).toBe(1_500);
  });
});

describe("PartialGate", () => {
  it("allows one pass at a time", () => {
    const gate = new PartialGate(1_000);
    expect(gate.tryBegin(0, false)).toBe(true);
    expect(gate.tryBegin(10, false)).toBe(false);
    gate.end(true, 20);
    expect(gate.tryBegin(30, false)).toBe(true);
  });

  it("stands aside while a final is pending", () => {
    const gate = new PartialGate(1_000);
    expect(gate.tryBegin(0, true)).toBe(false);
  });

  it("cools down after a failure and recovers after it", () => {
    const gate = new PartialGate(1_000);
    expect(gate.tryBegin(0, false)).toBe(true);
    gate.end(false, 100);
    expect(gate.isCoolingDown(500)).toBe(true);
    expect(gate.tryBegin(500, false)).toBe(false);
    expect(gate.tryBegin(1_100, false)).toBe(true);
  });

  it("reset clears both the slot and the cool-down", () => {
    const gate = new PartialGate(60_000);
    gate.tryBegin(0, false);
    gate.end(false, 0);
    gate.reset();
    expect(gate.tryBegin(1, false)).toBe(true);
  });
});

describe("isPartialCurrent", () => {
  it("rejects a partial that lands after its final", () => {
    expect(isPartialCurrent(3, 2)).toBe(true);
    expect(isPartialCurrent(3, 3)).toBe(false);
    expect(isPartialCurrent(2, 3)).toBe(false);
  });
});
