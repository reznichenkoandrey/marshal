import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TranslatorGlossaryStore,
  buildGlossaryEntry,
  isGlossaryEntry,
  selectGlossaryEntries,
  termOccursIn,
  type GlossaryEntry
} from "../desktop/translator/glossary-store.ts";
import { buildOcrTranslatePrompt, buildTranslateJsonPrompt } from "../desktop/translator/backends/shared.ts";

const entry = (term: string, translations: Record<string, string> = {}): GlossaryEntry => ({
  term,
  translations
});

describe("termOccursIn", () => {
  it("matches case-insensitively", () => {
    expect(termOccursIn("We hit the Rate Limit again", "rate limit")).toBe(true);
  });

  it("respects term boundaries", () => {
    expect(termOccursIn("the tag was stale", "tag")).toBe(true);
    // "tag" inside "tagged" is a different word and must not match.
    expect(termOccursIn("the tagged release", "tag")).toBe(false);
    expect(termOccursIn("vintage wine", "tag")).toBe(false);
  });

  it("works on Cyrillic terms — \\b would miss these entirely", () => {
    expect(termOccursIn("тег кешу застарів", "тег кешу")).toBe(true);
    expect(termOccursIn("мітка кешу застаріла", "тег кешу")).toBe(false);
    // A Cyrillic term inside a longer Cyrillic word is not a match.
    expect(termOccursIn("розгортання", "гортання")).toBe(false);
  });

  it("matches terms containing punctuation and underscores", () => {
    expect(termOccursIn("Run bin/magento cache:flush now", "bin/magento cache:flush")).toBe(true);
    expect(termOccursIn("the product_flat index", "product_flat")).toBe(true);
    // A regex metacharacter in the term is escaped, not interpreted.
    expect(termOccursIn("a.b.c", "a.b.c")).toBe(true);
    expect(termOccursIn("axbxc", "a.b.c")).toBe(false);
  });

  it("ignores blank terms", () => {
    expect(termOccursIn("anything", "")).toBe(false);
    expect(termOccursIn("anything", "   ")).toBe(false);
  });
});

describe("selectGlossaryEntries", () => {
  const glossary = [
    entry("backoff"),
    entry("cache tag", { uk: "тег кешу" }),
    entry("tag", { uk: "тег" }),
    entry("product_flat")
  ];

  it("returns only terms that occur in the text", () => {
    const picked = selectGlossaryEntries("The cache tag was stale", glossary);
    expect(picked.map((e) => e.term)).toEqual(["cache tag", "tag"]);
  });

  it("puts longer terms first so a multi-word entry wins", () => {
    const picked = selectGlossaryEntries("cache tag", glossary);
    expect(picked[0].term).toBe("cache tag");
  });

  it("returns nothing for empty text or an empty glossary", () => {
    expect(selectGlossaryEntries("", glossary)).toEqual([]);
    expect(selectGlossaryEntries("   ", glossary)).toEqual([]);
    expect(selectGlossaryEntries("anything", [])).toEqual([]);
  });

  it("does not smuggle in unrelated terms — that is the whole point", () => {
    const picked = selectGlossaryEntries("Nothing relevant here", glossary);
    expect(picked).toEqual([]);
  });
});

describe("glossary in the prompt", () => {
  it("states an exact rendering for a mapped term", () => {
    const prompt = buildTranslateJsonPrompt("The cache tag was stale", "uk", {
      glossary: [entry("cache tag", { uk: "тег кешу" })]
    });
    expect(prompt).toContain('"cache tag" -> "тег кешу"');
    expect(prompt).toContain("overriding your own preference");
  });

  it("asks for a term to be left alone when there is no rendering", () => {
    const prompt = buildTranslateJsonPrompt("retry with backoff", "uk", {
      glossary: [entry("backoff")]
    });
    expect(prompt).toContain('Leave these terms completely unchanged');
    expect(prompt).toContain('"backoff"');
    expect(prompt).not.toContain("->");
  });

  it("separates the two demands instead of lumping them together", () => {
    const prompt = buildTranslateJsonPrompt("cache tag and backoff", "uk", {
      glossary: [entry("cache tag", { uk: "тег кешу" }), entry("backoff")]
    });
    expect(prompt).toContain('"cache tag" -> "тег кешу"');
    expect(prompt).toContain('unchanged, in the original language: "backoff"');
  });

  it("ignores a rendering meant for another target language", () => {
    const prompt = buildTranslateJsonPrompt("cache tag", "de", {
      glossary: [entry("cache tag", { uk: "тег кешу" })]
    });
    expect(prompt).not.toContain("тег кешу");
    expect(prompt).toContain('unchanged, in the original language: "cache tag"');
  });

  it("adds nothing when the glossary is absent or empty", () => {
    expect(buildTranslateJsonPrompt("hello", "uk")).not.toContain("unchanged, in the original");
    expect(buildTranslateJsonPrompt("hello", "uk", { glossary: [] })).not.toContain("Use these exact");
  });

  it("applies to the OCR prompt too", () => {
    const prompt = buildOcrTranslatePrompt("uk", { glossary: [entry("product_flat")] });
    expect(prompt).toContain('"product_flat"');
  });
});

describe("buildGlossaryEntry", () => {
  it("keeps a term with no translation — that means leave it alone", () => {
    expect(buildGlossaryEntry("backoff")).toEqual({ term: "backoff", translations: {} });
  });

  it("records a translation under the normalised language code", () => {
    expect(buildGlossaryEntry("cache tag", "UK", "тег кешу")).toEqual({
      term: "cache tag",
      translations: { uk: "тег кешу" }
    });
  });

  it("trims, and ignores a blank translation", () => {
    expect(buildGlossaryEntry("  backoff  ", "uk", "   ")).toEqual({
      term: "backoff",
      translations: {}
    });
  });

  it("rejects input that is not a usable term", () => {
    expect(buildGlossaryEntry("")).toBeNull();
    expect(buildGlossaryEntry("   ")).toBeNull();
    expect(buildGlossaryEntry(undefined)).toBeNull();
    expect(buildGlossaryEntry(42)).toBeNull();
  });
});

describe("isGlossaryEntry", () => {
  it("rejects malformed stored data", () => {
    expect(isGlossaryEntry({ term: "x", translations: {} })).toBe(true);
    expect(isGlossaryEntry({ term: "", translations: {} })).toBe(false);
    expect(isGlossaryEntry({ term: "x" })).toBe(false);
    expect(isGlossaryEntry({ term: "x", translations: { uk: 5 } })).toBe(false);
    expect(isGlossaryEntry(null)).toBe(false);
  });
});

describe("TranslatorGlossaryStore", () => {
  let dir = "";
  let store: TranslatorGlossaryStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-glossary-"));
    store = new TranslatorGlossaryStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty and survives a missing file", () => {
    expect(store.list()).toEqual([]);
  });

  it("round-trips an entry", () => {
    store.upsert(entry("backoff"));
    expect(new TranslatorGlossaryStore(dir).list()).toEqual([{ term: "backoff", translations: {} }]);
  });

  it("merges translations instead of dropping the other languages", () => {
    store.upsert(entry("cache tag", { uk: "тег кешу" }));
    const next = store.upsert(entry("cache tag", { de: "Cache-Tag" }));
    expect(next).toHaveLength(1);
    expect(next[0].translations).toEqual({ uk: "тег кешу", de: "Cache-Tag" });
  });

  it("treats the term case-insensitively when merging", () => {
    store.upsert(entry("Backoff"));
    const next = store.upsert(entry("backoff", { uk: "бекоф" }));
    expect(next).toHaveLength(1);
  });

  it("removes by term, case-insensitively", () => {
    store.upsert(entry("backoff"));
    store.upsert(entry("cache tag"));
    expect(store.remove("BACKOFF").map((e) => e.term)).toEqual(["cache tag"]);
  });

  it("clears everything", () => {
    store.upsert(entry("backoff"));
    expect(store.clear()).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it("drops malformed entries on read rather than throwing", () => {
    fs.writeFileSync(
      path.join(dir, "translator-glossary.json"),
      JSON.stringify([{ term: "ok", translations: {} }, { nope: true }, "garbage"]),
      "utf8"
    );
    expect(store.list()).toEqual([{ term: "ok", translations: {} }]);
  });

  it("writes owner-only, like the rest of the user's data", () => {
    if (process.platform === "win32") return;
    store.upsert(entry("backoff"));
    const mode = fs.statSync(path.join(dir, "translator-glossary.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
