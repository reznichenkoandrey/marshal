// tests/decks-model.test.ts
//
// Operations from the model are untrusted input: a wrong index or an unknown
// op is refused with a reason, html is sanitised on the way in, and the
// exported document carries no script, no external URL and no notes. See #277.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_SLIDES,
  applyDeckOp,
  buildDeckHtml,
  buildSlideHtml,
  createDeck,
  isDeckId,
  newDeckId,
  parseDeckOp,
  validateDeck,
  type Deck,
  type DeckOp
} from "../desktop/decks/deck-model.ts";
import { DeckStore } from "../desktop/decks/deck-store.ts";
import { OpScanner } from "../desktop/decks/op-scanner.ts";

function parsed(raw: unknown): DeckOp {
  const result = parseDeckOp(raw);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function build(ops: unknown[], language: "uk" | "en" = "uk"): Deck {
  let deck = createDeck({ id: "deck-test", language, now: 1 });
  for (const raw of ops) {
    const result = applyDeckOp(deck, parsed(raw), 2);
    if (!result.ok) throw new Error(result.reason);
    deck = result.value;
  }
  return deck;
}

describe("parseDeckOp", () => {
  it("accepts deck and slide operations", () => {
    expect(parsed({ op: "deck", title: "T", theme: "light", language: "en" })).toEqual({
      op: "deck",
      title: "T",
      theme: "light",
      language: "en"
    });
    expect(parsed({ op: "slide", index: 2, layout: "bullets", html: "<p>a</p>", notes: "say this" })).toEqual({
      op: "slide",
      index: 2,
      layout: "bullets",
      html: "<p>a</p>",
      notes: "say this"
    });
  });

  it("falls back on an unknown layout, theme or language instead of losing the slide", () => {
    expect(parsed({ op: "slide", index: 1, layout: "hero", html: "" })).toMatchObject({ layout: "content", notes: "" });
    expect(parsed({ op: "deck", title: "T", theme: "neon", language: "de" })).toEqual({
      op: "deck",
      title: "T",
      theme: undefined,
      language: undefined
    });
  });

  it("refuses unknown ops and bad indexes with a reason", () => {
    for (const raw of [
      null,
      [],
      "slide",
      { op: "reorder", from: 1, to: 2 },
      { op: "slide", index: 0, html: "" },
      { op: "slide", index: 1.5, html: "" },
      { op: "slide", index: "2", html: "" },
      { op: "slide", index: MAX_SLIDES + 1, html: "" },
      { op: "slide", index: 1 },
      { op: "deck" }
    ]) {
      const result = parseDeckOp(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).not.toBe("");
    }
  });
});

describe("applyDeckOp", () => {
  it("appends, replaces and sanitises slides without mutating the input", () => {
    const empty = createDeck({ id: "deck-test", language: "uk", now: 1 });
    const deck = build([
      { op: "deck", title: "Релізи" },
      { op: "slide", index: 1, layout: "title", html: "<h1>Жовтень</h1><script>x</script>" },
      { op: "slide", index: 2, html: "<p>old</p>" },
      { op: "slide", index: 2, html: '<p onclick="x">new</p>', notes: "нотатка" }
    ]);
    expect(empty.slides).toEqual([]);
    expect(deck.title).toBe("Релізи");
    expect(deck.updatedAt).toBe(2);
    expect(deck.slides).toEqual([
      { layout: "title", html: "<h1>Жовтень</h1>", notes: "" },
      { layout: "content", html: "<p>new</p>", notes: "нотатка" }
    ]);
  });

  it("refuses a slide that would leave a gap", () => {
    const deck = build([{ op: "slide", index: 1, html: "a" }]);
    const result = applyDeckOp(deck, parsed({ op: "slide", index: 3, html: "c" }));
    expect(result).toEqual({ ok: false, reason: "slide: index 3 skips past slide 1" });
  });

  it("keeps theme and language when the deck op does not name them", () => {
    const deck = build([{ op: "deck", title: "A", theme: "light" }, { op: "deck", title: "B" }], "en");
    expect(deck).toMatchObject({ title: "B", theme: "light", language: "en" });
  });
});

describe("stream to deck", () => {
  it("builds the slides that arrived and skips the ones that did not validate", () => {
    const stream = [
      { op: "deck", title: "Marshal releases" },
      { op: "slide", index: 1, layout: "title", html: "<h1>October</h1>" },
      { op: "note", text: "ignored" },
      { op: "slide", index: 5, html: "<p>gap</p>" },
      { op: "slide", index: 2, layout: "bullets", html: "<ul><li>0.6.0</li></ul>" }
    ]
      .map((op) => JSON.stringify(op))
      .join("\n");

    const scanner = new OpScanner();
    const rejected: string[] = [];
    let deck = createDeck({ id: "deck-test", language: "en" });
    for (let i = 0; i < stream.length; i += 11) {
      for (const scanned of scanner.feed(stream.slice(i, i + 11))) {
        const op = scanned.ok ? parseDeckOp(scanned.value) : scanned;
        const applied = op.ok ? applyDeckOp(deck, op.value) : op;
        if (applied.ok) deck = applied.value;
        else rejected.push(applied.reason);
      }
    }
    expect(deck.slides.map((slide) => slide.html)).toEqual(["<h1>October</h1>", "<ul><li>0.6.0</li></ul>"]);
    expect(rejected).toEqual(['unknown op "note"', "slide: index 5 skips past slide 1"]);
  });
});

describe("deck HTML", () => {
  const deck = build([
    { op: "deck", title: 'Релізи <Marshal> & "друзі"' },
    { op: "slide", index: 1, layout: "title", html: "<h1>Жовтень</h1>", notes: "секретна нотатка" },
    { op: "slide", index: 2, layout: "bullets", html: "<ul><li>Holos</li></ul>" }
  ]);

  it("exports one self-contained document in the deck language", () => {
    const html = buildDeckHtml(deck);
    expect(html).toContain('<html lang="uk">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<title>Релізи &lt;Marshal&gt; &amp; &quot;друзі&quot;</title>");
    expect(html).toContain('<section class="slide layout-title"><h1>Жовтень</h1></section>');
    expect(html).toContain('<section class="slide layout-bullets"><ul><li>Holos</li></ul></section>');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script|https?:|\ssrc=|\shref=|@import|url\(/i);
    expect(html).not.toContain("секретна нотатка");
  });

  it("sanitises again at render time, so a deck object built elsewhere is still safe", () => {
    const tampered: Deck = { ...deck, slides: [{ layout: "content", html: "<script>x</script><p>a</p>", notes: "" }] };
    expect(buildDeckHtml(tampered)).toContain('<section class="slide layout-content"><p>a</p></section>');
    expect(buildDeckHtml(tampered)).not.toContain("<script");
  });

  it("renders one slide for a frame, by 1-based index", () => {
    const html = buildSlideHtml(deck, 2) ?? "";
    expect(html).toContain("Holos");
    expect(html).not.toContain("Жовтень");
    expect(buildSlideHtml(deck, 0)).toBeNull();
    expect(buildSlideHtml(deck, 3)).toBeNull();
  });

  it("uses the theme palette", () => {
    const light = build([{ op: "deck", title: "T", theme: "light" }], "en");
    expect(buildDeckHtml(light)).toContain("--deck-bg:#ffffff");
    expect(buildDeckHtml(light)).toContain('<html lang="en">');
  });
});

describe("deck ids", () => {
  it("generates ids the store accepts and refuses anything path-like", () => {
    expect(isDeckId(newDeckId())).toBe(true);
    expect(newDeckId(0, () => 0)).toBe("deck-0-0000");
    for (const id of ["", "../x", "a/b", "A", "deck.json", ".hidden", 7]) expect(isDeckId(id)).toBe(false);
  });
});

describe("validateDeck", () => {
  const deck = build([{ op: "deck", title: "T" }, { op: "slide", index: 1, html: "<p>a</p>" }]);

  it("round-trips a deck through JSON", () => {
    expect(validateDeck(JSON.parse(JSON.stringify(deck)))).toEqual(deck);
  });

  it("refuses malformed files and re-sanitises stored html", () => {
    expect(validateDeck(null)).toBeNull();
    expect(validateDeck({ ...deck, id: "../x" })).toBeNull();
    expect(validateDeck({ ...deck, language: "de" })).toBeNull();
    expect(validateDeck({ ...deck, slides: "none" })).toBeNull();
    expect(validateDeck({ ...deck, slides: [{ html: 1 }] })).toBeNull();
    expect(validateDeck({ ...deck, updatedAt: "now" })).toBeNull();
    const tampered = validateDeck({ ...deck, slides: [{ layout: "x", html: '<p onclick="x">a</p>' }] });
    expect(tampered?.slides).toEqual([{ layout: "content", html: "<p>a</p>", notes: "" }]);
  });
});

describe("DeckStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-decks-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function deckAt(id: string, updatedAt: number): Deck {
    return { ...createDeck({ id, title: id, language: "uk", now: updatedAt }) };
  }

  it("saves, loads, lists newest first and removes", () => {
    const store = new DeckStore(path.join(dir, "decks"));
    expect(store.list()).toEqual([]);
    store.save(deckAt("deck-a", 1));
    store.save(deckAt("deck-b", 2));
    expect(store.load("deck-a")).toEqual(deckAt("deck-a", 1));
    expect(store.list().map((deck) => deck.id)).toEqual(["deck-b", "deck-a"]);
    expect(store.list()[0]).toMatchObject({ title: "deck-b", language: "uk", slideCount: 0 });
    expect(store.remove("deck-a")).toBe(true);
    expect(store.remove("deck-a")).toBe(false);
    expect(store.load("deck-a")).toBeNull();
    expect(fs.readdirSync(path.join(dir, "decks"))).toEqual(["deck-b.json"]);
  });

  it("refuses ids that would leave the folder", () => {
    const store = new DeckStore(dir);
    fs.writeFileSync(path.join(dir, "..", "marshal-decks-outside.json"), "{}");
    expect(store.load("../marshal-decks-outside")).toBeNull();
    expect(store.remove("../marshal-decks-outside")).toBe(false);
    expect(() => store.save({ ...deckAt("deck-a", 1), id: "../x" })).toThrow("invalid deck id");
    fs.rmSync(path.join(dir, "..", "marshal-decks-outside.json"));
  });

  it("skips files that are not decks or whose id does not match the name", () => {
    const store = new DeckStore(dir);
    store.save(deckAt("deck-a", 1));
    fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
    fs.writeFileSync(path.join(dir, "deck-renamed.json"), JSON.stringify(deckAt("deck-other", 5)));
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    expect(store.list().map((deck) => deck.id)).toEqual(["deck-a"]);
  });

  it("names the oldest decks past the caps and deletes nothing itself", () => {
    const store = new DeckStore(dir, { maxEntries: 2, maxBytes: 1024 * 1024 });
    for (const [id, at] of [["deck-a", 1], ["deck-b", 2], ["deck-c", 3]] as const) store.save(deckAt(id, at));
    expect(store.overBudget()).toEqual(["deck-a"]);
    expect(store.list()).toHaveLength(3);

    const tight = new DeckStore(dir, { maxEntries: 10, maxBytes: 1 });
    expect(tight.overBudget()).toEqual(["deck-b", "deck-a"]);
  });
});
