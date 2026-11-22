// tests/decks-op-scanner.test.ts
//
// The scanner decides when a slide is complete enough to apply. Every case
// here is a way a real model stream arrives: cut at arbitrary bytes, with
// braces and quotes inside html, or ending mid-slide. See #277.

import { describe, expect, it } from "vitest";

import { MAX_OP_CHARS, OpScanner, partialStringField, type ScannedOp } from "../desktop/decks/op-scanner.ts";

const DECK = { op: "deck", title: "Релізи Marshal" };
const SLIDE_1 = { op: "slide", index: 1, layout: "title", html: "<h1>Жовтень</h1>" };
const SLIDE_2 = {
  op: "slide",
  index: 2,
  layout: "content",
  html: '<p style="color: red">a } b { c "quoted" \\ back</p>\n<code>{"x":1}</code>'
};
const STREAM = [DECK, SLIDE_1, SLIDE_2].map((op) => JSON.stringify(op)).join("\n");

function values(results: ScannedOp[]): unknown[] {
  return results.map((result) => (result.ok ? result.value : result));
}

function feedInPieces(text: string, size: number): unknown[] {
  const scanner = new OpScanner();
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...values(scanner.feed(text.slice(i, i + size))));
  return out;
}

describe("OpScanner", () => {
  it("yields the same operations whatever the chunk size", () => {
    for (const size of [1, 2, 3, 7, 16, 61, STREAM.length]) {
      expect(feedInPieces(STREAM, size)).toEqual([DECK, SLIDE_1, SLIDE_2]);
    }
  });

  it("holds an operation back until its closing brace arrives", () => {
    const scanner = new OpScanner();
    const text = JSON.stringify(SLIDE_1);
    expect(scanner.feed(text.slice(0, -1))).toEqual([]);
    expect(scanner.pending).toBe(text.slice(0, -1));
    expect(values(scanner.feed("}"))).toEqual([SLIDE_1]);
    expect(scanner.pending).toBe("");
  });

  it("keeps braces, quotes and escapes inside html from moving the boundary", () => {
    expect(feedInPieces(JSON.stringify(SLIDE_2), 1)).toEqual([SLIDE_2]);
  });

  it("handles an escape split across chunks", () => {
    const scanner = new OpScanner();
    expect(scanner.feed('{"op":"slide","html":"a\\')).toEqual([]);
    expect(values(scanner.feed('"}b\\u00e9"}'))).toEqual([{ op: "slide", html: 'a"}bé' }]);
  });

  it("ignores what sits between operations: fences, commas, array brackets, prose", () => {
    const text = `Here is the deck:\n\`\`\`json\n[${JSON.stringify(DECK)},\n${JSON.stringify(SLIDE_1)}]\n\`\`\``;
    expect(feedInPieces(text, 5)).toEqual([DECK, SLIDE_1]);
  });

  it("keeps applied operations when the stream breaks off mid-slide", () => {
    const text = `${JSON.stringify(DECK)}\n${JSON.stringify(SLIDE_1)}\n${JSON.stringify(SLIDE_2).slice(0, 40)}`;
    expect(feedInPieces(text, 9)).toEqual([DECK, SLIDE_1]);
  });

  it("reports an object that is not JSON and carries on", () => {
    const scanner = new OpScanner();
    const results = scanner.feed(`{op: "slide"}\n${JSON.stringify(SLIDE_1)}`);
    expect(results[0].ok).toBe(false);
    expect(values(results.slice(1))).toEqual([SLIDE_1]);
  });

  it("drops a runaway operation without treating its tail as new ones", () => {
    const scanner = new OpScanner();
    const results = scanner.feed(`{"op":"slide","html":"${"x".repeat(MAX_OP_CHARS)}`);
    expect(results).toEqual([{ ok: false, reason: `operation exceeds ${MAX_OP_CHARS} characters` }]);
    expect(scanner.pending).toBe("");
    expect(scanner.feed(' {"op":"deck"} still inside the string')).toEqual([]);
    expect(values(scanner.feed(`"}\n${JSON.stringify(SLIDE_1)}`))).toEqual([SLIDE_1]);
  });
});

describe("partialStringField", () => {
  it("returns the html written so far", () => {
    expect(partialStringField('{"op":"slide","index":2,"html":"<h2>Реліз</h2><ul><li>од', "html")).toBe(
      "<h2>Реліз</h2><ul><li>од"
    );
  });

  it("decodes escapes and leaves a half-written one out", () => {
    expect(partialStringField('{"html":"a\\"b\\n\\u0456', "html")).toBe('a"b\nі');
    expect(partialStringField('{"html":"a\\', "html")).toBe("a");
    expect(partialStringField('{"html":"a\\u04', "html")).toBe("a");
  });

  it("stops at the closing quote and returns null before the field starts", () => {
    expect(partialStringField('{"html":"done","notes":"x', "html")).toBe("done");
    expect(partialStringField('{"op":"slide","index":2', "html")).toBeNull();
  });
});
