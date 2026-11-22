// tests/decks-generator.test.ts
//
// Stage 2 of voice decks (#277): the owner's words become a request, the
// model's stream becomes slides as each operation closes, and the service
// turns that into the state the window draws. The model is a fake stream;
// nothing here needs Electron or a network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SLIDE_COUNT,
  MAX_GENERATED_SLIDES,
  buildDeckMessages,
  deckMaxTokens,
  generateDeck,
  parseDeckRequest,
  type DeckBuildEvent,
  type DeckRequest,
  type DeckStream
} from "../desktop/decks/deck-generator.ts";
import { parseDeckOp } from "../desktop/decks/deck-model.ts";
import { DeckService, deckFileName, deckViewState, slideLabel, type DeckViewState } from "../desktop/decks/deck-service.ts";
import { DeckStore } from "../desktop/decks/deck-store.ts";

const REQUEST: DeckRequest = { topic: "3 слайди про rate limit", slideCount: 3, language: "uk" };

const DECK_LINE = JSON.stringify({ op: "deck", title: "Rate limit", language: "en", outline: ["Вступ", "Як працює", "Висновки"] });
const slideLine = (index: number, title: string): string =>
  JSON.stringify({ op: "slide", index, layout: index === 1 ? "title" : "bullets", html: `<h2>${title}</h2><p>Текст ${index}</p>`, notes: `Нотатка ${index}` });
const FULL = [DECK_LINE, slideLine(1, "Вступ"), slideLine(2, "Як працює"), slideLine(3, "Висновки")].join("\n");

/** A model that sends `text` in pieces of `size` characters. */
function chunked(text: string, size: number): DeckStream {
  return async (_messages, _maxTokens, onDelta) => {
    for (let i = 0; i < text.length; i += size) onDelta(text.slice(i, i + size));
    return text;
  };
}

async function run(stream: DeckStream, request = REQUEST, now?: () => number) {
  const events: DeckBuildEvent[] = [];
  const log: string[] = [];
  const result = await generateDeck({
    id: "deck-test",
    request,
    stream,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    log: (line) => log.push(line),
    now
  });
  return { result, events, log };
}

describe("parseDeckRequest", () => {
  it("reads the number of slides from digits and from words", () => {
    expect(parseDeckRequest("зроби 7 слайдів про деплой")?.slideCount).toBe(7);
    expect(parseDeckRequest("зроби п’ять слайдів про деплой")?.slideCount).toBe(5);
    expect(parseDeckRequest("make three slides about caching")?.slideCount).toBe(3);
    expect(parseDeckRequest("a six-slide deck about caching")?.slideCount).toBe(6);
  });

  it("falls back to the default and clamps to the cap", () => {
    expect(parseDeckRequest("презентація про whisper")?.slideCount).toBe(DEFAULT_SLIDE_COUNT);
    expect(parseDeckRequest("90 slides about everything")?.slideCount).toBe(MAX_GENERATED_SLIDES);
  });

  it("takes the language from the words and keeps them as the topic", () => {
    expect(parseDeckRequest("  слайди   про rate limit  ")).toMatchObject({ topic: "слайди про rate limit", language: "uk" });
    expect(parseDeckRequest("a deck about rate limits")?.language).toBe("en");
  });

  it("has nothing to build from an empty request", () => {
    expect(parseDeckRequest("   ")).toBeNull();
  });
});

describe("buildDeckMessages", () => {
  it("states the count and the language, and carries the request as data", () => {
    const messages = buildDeckMessages(REQUEST);
    expect(messages.system).toContain("exactly 3 slides");
    expect(messages.system).toContain("in Ukrainian");
    expect(messages.user).toContain(REQUEST.topic);
    expect(buildDeckMessages({ ...REQUEST, language: "en" }).system).toContain("in English");
  });

  it("budgets tokens by slide count, up to a ceiling", () => {
    expect(deckMaxTokens(3)).toBeLessThan(deckMaxTokens(8));
    expect(deckMaxTokens(100)).toBe(8192);
  });
});

describe("parseDeckOp outline", () => {
  it("keeps string titles and drops the rest", () => {
    const op = parseDeckOp({ op: "deck", title: "T", outline: ["a", 5, "b"] });
    expect(op.ok && op.value.op === "deck" ? op.value.outline : null).toEqual(["a", "b"]);
  });
});

describe("generateDeck", () => {
  it("applies each slide as its operation closes, whatever the chunking", async () => {
    for (const size of [1, 7, 4096]) {
      const { result, events } = await run(chunked(FULL, size));
      expect(result.error).toBeNull();
      expect(result.deck.slides.map((slide) => slide.notes)).toEqual(["Нотатка 1", "Нотатка 2", "Нотатка 3"]);
      expect(events.filter((event) => event.type === "outline")).toEqual([{ type: "outline", titles: ["Вступ", "Як працює", "Висновки"] }]);
      const counts = events.flatMap((event) => (event.type === "slide" ? [event.deck.slides.length] : []));
      expect(counts).toEqual([0, 1, 2, 3]);
    }
  });

  it("keeps the language of the request, not the one the model claims", async () => {
    const { result } = await run(chunked(FULL, 50));
    expect(result.deck.language).toBe("uk");
    expect(result.deck.title).toBe("Rate limit");
  });

  it("drops slides past the requested count and says so", async () => {
    const { result, log } = await run(chunked(`${FULL}\n${slideLine(4, "Зайвий")}`, 64));
    expect(result.deck.slides).toHaveLength(3);
    expect(log.join("\n")).toContain("slide 4 is past the 3 requested");
  });

  it("reports the growing slide sanitised and no more often than the interval", async () => {
    let clock = 1000;
    const open = `${DECK_LINE}\n{"op":"slide","index":1,"layout":"title","html":"<h1>Привіт</h1><script>alert(1)</script><p>ще`;
    const stream: DeckStream = async (_messages, _maxTokens, onDelta) => {
      onDelta(open);
      onDelta(" трохи");
      clock += 300;
      onDelta(" тексту");
      return "";
    };
    const { events } = await run(stream, REQUEST, () => clock);
    const partials = events.filter((event) => event.type === "partial");
    expect(partials).toHaveLength(2);
    expect(partials[0]).toMatchObject({ index: 1 });
    expect(partials.every((event) => event.type === "partial" && !event.html.includes("script") && event.html.includes("Привіт"))).toBe(true);
  });

  it("keeps the slides built before the stream failed", async () => {
    const stream: DeckStream = async (_messages, _maxTokens, onDelta) => {
      onDelta(`${DECK_LINE}\n${slideLine(1, "Вступ")}\n`);
      throw new Error("429 rate limit");
    };
    const { result } = await run(stream);
    expect(result.error).toBe("429 rate limit");
    expect(result.deck.slides).toHaveLength(1);
  });

  it("ignores prose and broken lines between operations", async () => {
    const { result } = await run(chunked(`Here you go:\n\`\`\`json\n${DECK_LINE}\n{"op":"slide","index":"x"}\n${slideLine(1, "Вступ")}\n\`\`\``, 9));
    expect(result.deck.slides).toHaveLength(1);
  });
});

describe("deck view state", () => {
  it("labels a slide by its heading, as plain text", () => {
    expect(slideLabel("<h2>Rate <em>limit</em> &amp; backoff</h2><p>x</p>")).toBe("Rate limit & backoff");
    expect(slideLabel("<p>лише текст</p>")).toBe("лише текст");
    expect(slideLabel(`<h2>${"a".repeat(200)}</h2>`)).toHaveLength(80);
  });

  it("shows outline titles for slides that are not built yet", async () => {
    const { result } = await run(chunked(`${DECK_LINE}\n${slideLine(1, "Вступ")}`, 64));
    const state = deckViewState(result.deck, { status: "building", outline: ["Вступ", "Як працює", "Висновки"], expected: 3 });
    expect(state.slides.map((slide) => [slide.label, slide.document !== null])).toEqual([
      ["Вступ", true],
      ["Як працює", false],
      ["Висновки", false]
    ]);
    expect(state.slides[0].document).toContain("<!doctype html>");
    expect(deckViewState(result.deck, { status: "ready" }).slides).toHaveLength(1);
  });

  it("wraps the growing slide in a full document", async () => {
    const { result } = await run(chunked(DECK_LINE, 64));
    const state = deckViewState(result.deck, { status: "building", partialHtml: { index: 1, html: "<h1>Привіт</h1>" } });
    expect(state.partial?.index).toBe(1);
    expect(state.partial?.document).toContain("<h1>Привіт</h1>");
  });

  it("names the export file from the title, in any script", () => {
    expect(deckFileName("Rate limit: що далі?", "pdf")).toBe("Rate-limit-що-далі.pdf");
    expect(deckFileName("../../etc/passwd", "html")).toBe("etc-passwd.html");
    expect(deckFileName("???", "pdf")).toBe("deck.pdf");
  });
});

describe("DeckService", () => {
  let dir: string;
  let states: DeckViewState[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-decks-"));
    states = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const service = (model: DeckStream | null) =>
    new DeckService({ store: new DeckStore(dir), model: () => model, onChange: (state) => states.push(state) });

  it("builds, publishes every step and saves the deck", async () => {
    const decks = service(chunked(FULL, 40));
    const final = await decks.build(REQUEST);
    expect(final.status).toBe("ready");
    expect(final.slides).toHaveLength(3);
    expect(states[0]).toMatchObject({ status: "building" });
    expect(states[0].slides.map((slide) => slide.label)).toEqual(["Вступ", "Як працює", "Висновки"]);
    expect(new DeckStore(dir).list()).toHaveLength(1);
    expect(decks.exportHtml()).toContain("Висновки");
  });

  it("says there is no model instead of building", async () => {
    const final = await service(null).build(REQUEST);
    expect(final).toMatchObject({ status: "error", error: "no-model", slides: [] });
  });

  it("reports an empty answer as no-slides and saves nothing", async () => {
    const decks = service(chunked("Sorry, I cannot do that.", 8));
    expect(await decks.build(REQUEST)).toMatchObject({ status: "error", error: "no-slides" });
    expect(decks.exportHtml()).toBeNull();
    expect(new DeckStore(dir).list()).toHaveLength(0);
  });

  it("keeps and saves what a failed stream built", async () => {
    const decks = service(async (_messages, _maxTokens, onDelta) => {
      onDelta(`${DECK_LINE}\n${slideLine(1, "Вступ")}\n`);
      throw new Error("network");
    });
    const final = await decks.build(REQUEST);
    expect(final).toMatchObject({ status: "error", error: "network" });
    expect(final.slides).toHaveLength(1);
    expect(new DeckStore(dir).list()).toHaveLength(1);
  });

  it("lets the newest build win and aborts the older one", async () => {
    let aborted = false;
    let release: () => void = () => {};
    const slow: DeckStream = (_messages, _maxTokens, onDelta, signal) =>
      new Promise((resolve) => {
        onDelta(`${DECK_LINE}\n`);
        signal.addEventListener("abort", () => (aborted = true));
        release = () => resolve("");
      });
    let model = slow;
    const decks = new DeckService({ store: new DeckStore(dir), model: () => model, onChange: (state) => states.push(state) });
    const first = decks.build(REQUEST);
    model = chunked(FULL, 64);
    const second = await decks.build({ ...REQUEST, topic: "друга" });
    release();
    await first;
    expect(aborted).toBe(true);
    expect(second.status).toBe("ready");
    expect(decks.state()).toBe(second);
  });

  it("opens the most recent stored deck", async () => {
    await service(chunked(FULL, 64)).build(REQUEST);
    states = [];
    const reopened = service(null);
    expect(reopened.openLatest()).toBe(true);
    expect(states.at(-1)).toMatchObject({ status: "ready", title: "Rate limit" });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(service(null).openLatest()).toBe(false);
  });
});
