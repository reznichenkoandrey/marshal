// tests/captions-translation.test.ts
//
// Live translation of caption lines (#210). What must hold: one request per
// distinct line, answers that arrive out of order still land on the right
// line, a translation identical to the original is not shown twice, and a
// failing translator is left alone for a while instead of being asked again
// for every line.

import { describe, expect, it, vi } from "vitest";

import {
  CaptionTranslator,
  normalizeTranslation,
  resolveTranslationTarget,
  TRANSLATION_COOLDOWN_MS
} from "../desktop/captions/caption-translation.ts";
import { resolveLangCode } from "../desktop/translator/languages.ts";

/** A translator whose answers the test releases by hand, in any order. */
function controllable(): {
  translate: (text: string, targetLang: string) => Promise<string>;
  resolve: (text: string, translation: string) => void;
  reject: (text: string, err: Error) => void;
  calls: string[];
} {
  const pending = new Map<string, { resolve: (value: string) => void; reject: (err: Error) => void }>();
  const calls: string[] = [];
  return {
    calls,
    translate: (text) =>
      new Promise((resolve, reject) => {
        calls.push(text);
        pending.set(text, { resolve, reject });
      }),
    resolve: (text, translation) => pending.get(text)?.resolve(translation),
    reject: (text, err) => pending.get(text)?.reject(err)
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("CaptionTranslator", () => {
  it("asks once per line and exposes the answer by text, whatever the order", async () => {
    const fake = controllable();
    const translator = new CaptionTranslator({ translate: fake.translate, targetLang: "uk" });

    translator.request("We shard by tenant id.");
    translator.request("Reads go to the replicas.");
    translator.request("We shard by tenant id."); // already in flight
    expect(fake.calls).toEqual(["We shard by tenant id.", "Reads go to the replicas."]);

    // The second answer arrives first — it must attach to its own line.
    fake.resolve("Reads go to the replicas.", "Читання йдуть на репліки.");
    await flush();
    expect(translator.get("Reads go to the replicas.")).toBe("Читання йдуть на репліки.");
    expect(translator.get("We shard by tenant id.")).toBeNull();
    expect(translator.isPending("We shard by tenant id.")).toBe(true);

    fake.resolve("We shard by tenant id.", "Ми шардимо по tenant id.");
    await flush();
    expect(translator.get("We shard by tenant id.")).toBe("Ми шардимо по tenant id.");
    translator.request("We shard by tenant id."); // known: no new request
    expect(fake.calls).toHaveLength(2);
  });

  it("repaints when a translation lands", async () => {
    const fake = controllable();
    const onUpdate = vi.fn();
    const translator = new CaptionTranslator({ translate: fake.translate, targetLang: "uk", onUpdate });
    translator.request("Hello.");
    fake.resolve("Hello.", "Привіт.");
    await flush();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("hides a translation that only repeats the original", async () => {
    const fake = controllable();
    const translator = new CaptionTranslator({ translate: fake.translate, targetLang: "uk" });
    translator.request("Ми шардимо по tenant id.");
    fake.resolve("Ми шардимо по tenant id.", "  Ми   шардимо по tenant id. ");
    await flush();
    expect(translator.get("Ми шардимо по tenant id.")).toBeNull();
    expect(translator.isPending("Ми шардимо по tenant id.")).toBe(false);
  });

  it("backs off after a failure instead of asking for every next line", async () => {
    const fake = controllable();
    const onError = vi.fn();
    const translator = new CaptionTranslator({ translate: fake.translate, targetLang: "uk", onError, cooldownMs: 1_000 });
    const t0 = 1_000_000;

    translator.request("First line.", t0);
    fake.reject("First line.", new Error("429 rate limited"));
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(translator.get("First line.")).toBeNull();

    translator.request("Second line.", t0 + 500); // inside the cool-down
    expect(fake.calls).toEqual(["First line."]);

    translator.request("Third line.", Date.now() + 5_000); // after it
    expect(fake.calls).toEqual(["First line.", "Third line."]);
    // The failed line itself is not retried on the next repaint either.
    translator.request("First line.", Date.now() + 5_000);
    expect(fake.calls).toHaveLength(2);
  });

  it("forgets the oldest lines past the cache bound", async () => {
    const fake = controllable();
    const translator = new CaptionTranslator({ translate: fake.translate, targetLang: "uk", maxCached: 2 });
    for (const line of ["a one", "b two", "c three"]) {
      translator.request(line);
      fake.resolve(line, `${line} uk`);
      await flush();
    }
    expect(translator.get("a one")).toBeNull();
    expect(translator.get("b two")).toBe("b two uk");
    expect(translator.get("c three")).toBe("c three uk");
  });

  it("ignores blank lines", () => {
    const fake = controllable();
    const translator = new CaptionTranslator({ translate: fake.translate, targetLang: "uk" });
    translator.request("   ");
    expect(fake.calls).toEqual([]);
  });

  it("uses the default cool-down when none is given", () => {
    expect(TRANSLATION_COOLDOWN_MS).toBe(30_000);
  });
});

describe("normalizeTranslation", () => {
  it("collapses whitespace and drops empty or identical output", () => {
    expect(normalizeTranslation("Hello.", "  Привіт,  світе. ")).toBe("Привіт, світе.");
    expect(normalizeTranslation("Hello.", "hello.")).toBeNull();
    expect(normalizeTranslation("Hello.", "")).toBeNull();
  });
});

describe("resolveTranslationTarget", () => {
  it("defaults to Ukrainian and honours a code or off", () => {
    expect(resolveTranslationTarget(undefined, resolveLangCode)).toBe("uk");
    expect(resolveTranslationTarget("", resolveLangCode)).toBe("uk");
    expect(resolveTranslationTarget("de", resolveLangCode)).toBe("de");
    expect(resolveTranslationTarget("en-US", resolveLangCode)).toBe("en");
    expect(resolveTranslationTarget("klingon", resolveLangCode)).toBe("uk");
    expect(resolveTranslationTarget("off", resolveLangCode)).toBeNull();
    expect(resolveTranslationTarget("0", resolveLangCode)).toBeNull();
  });
});
