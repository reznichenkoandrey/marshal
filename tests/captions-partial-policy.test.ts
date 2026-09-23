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
  MAX_PARTIAL_COOLDOWN_MS,
  MIN_PARTIAL_COOLDOWN_MS,
  MIN_PARTIAL_INTERVAL_MS,
  PartialGate,
  parseRetryAfterMs,
  resolvePartialBackend,
  resolvePartialIntervalMs
} from "../desktop/captions/partial-policy.ts";

describe("resolvePartialBackend", () => {
  it("is on by default on every backend, the local one included (#208)", () => {
    expect(resolvePartialBackend(undefined, "groq")).toBe("groq");
    expect(resolvePartialBackend(undefined, "hybrid")).toBe("groq");
    // Off until the model stayed resident: each partial cost 1.6 s (#218).
    expect(resolvePartialBackend(undefined, "whisper-cpp")).toBe("whisper-cpp");
  });

  it("never gives hybrid its local fallback", () => {
    // A rate-limited partial must fail, not drag everything onto whisper.cpp.
    expect(resolvePartialBackend("1", "hybrid")).toBe("groq");
  });

  it("can be turned off everywhere; `1` still means the default", () => {
    expect(resolvePartialBackend("1", "whisper-cpp")).toBe("whisper-cpp");
    expect(resolvePartialBackend("0", "groq")).toBeNull();
    expect(resolvePartialBackend("0", "whisper-cpp")).toBeNull();
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

describe("parseRetryAfterMs (#207)", () => {
  // The start is verbatim from the live run; the log cut it off there, so the
  // rest — which limit, and the wait — is Groq's documented shape, with the
  // limit left unnamed because the real one has not been seen yet.
  const groq = (wait: string): string =>
    `Groq whisper API 429: {"error":{"message":"Rate limit reached for model \`whisper-large-v3\` ` +
    `in organization \`org_…\` service tier \`on_demand\` on <limit>. Please try again in ${wait}."}}`;

  it("reads Groq's wait in every unit it uses", () => {
    expect(parseRetryAfterMs(groq("12.5s"))).toBe(12_500);
    expect(parseRetryAfterMs(groq("1m3.5s"))).toBe(63_500);
    expect(parseRetryAfterMs(groq("7m12s"))).toBe(432_000);
  });

  it("clamps a tiny wait up and a long one down", () => {
    expect(parseRetryAfterMs(groq("740ms"))).toBe(MIN_PARTIAL_COOLDOWN_MS);
    expect(parseRetryAfterMs(groq("2h1m"))).toBe(MAX_PARTIAL_COOLDOWN_MS);
  });

  it("returns null when there is no hint, so the default applies", () => {
    expect(parseRetryAfterMs("Groq whisper API 503: upstream unavailable")).toBeNull();
    expect(parseRetryAfterMs("try again in soon")).toBeNull();
  });
});

describe("PartialGate cool-down from the provider (#207)", () => {
  it("uses the provider's figure instead of the default", () => {
    const gate = new PartialGate(60_000);
    gate.tryBegin(0, false);
    gate.end(false, 0, 12_500);
    expect(gate.tryBegin(12_000, false)).toBe(false);
    expect(gate.tryBegin(12_500, false)).toBe(true);
  });

  it("falls back to the default when the provider gave none", () => {
    const gate = new PartialGate(60_000);
    gate.tryBegin(0, false);
    gate.end(false, 0, null);
    expect(gate.tryBegin(59_999, false)).toBe(false);
    expect(gate.tryBegin(60_000, false)).toBe(true);
  });
});

it("defaults to a partial every 1.5 s of speech (#207)", () => {
  expect(DEFAULT_PARTIAL_INTERVAL_MS).toBe(1_500);
});
