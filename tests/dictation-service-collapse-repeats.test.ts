// tests/dictation-service-collapse-repeats.test.ts
//
// Unit tests for collapseRepeats — the post-process layer that strips
// whisper.cpp's back-to-back n-gram repetition loops before the transcript
// reaches the clipboard. See issue #99 and the helper's docstring in
// desktop/dictation/dictation-service.ts for the why.

import { describe, expect, it } from "vitest";

import { collapseRepeats } from "../desktop/dictation/dictation-service.ts";

describe("collapseRepeats", () => {
  it("returns short inputs unchanged", () => {
    expect(collapseRepeats("")).toBe("");
    expect(collapseRepeats("hi")).toBe("hi");
    expect(collapseRepeats("дуже дуже дуже")).toBe("дуже дуже дуже");
  });

  it("collapses a single back-to-back duplicate at the tail", () => {
    const input =
      "пишеш мені російською а мені так нахуй не потрібно " +
      "пишеш мені російською а мені так нахуй не потрібно";
    const output = collapseRepeats(input);
    expect(output).toBe("пишеш мені російською а мені так нахуй не потрібно");
  });

  it("collapses three or more back-to-back repeats", () => {
    const sentence = "Це довге речення яке точно довше за поріг.";
    const input = `${sentence} ${sentence} ${sentence}`;
    expect(collapseRepeats(input)).toBe(sentence);
  });

  it("collapses repeats that appear mid-string", () => {
    const chunk = "long enough chunk to trigger the collapser";
    const input = `prefix text ${chunk} ${chunk} suffix text`;
    // The "$1" replace leaves a trailing space — that's fine, downstream
    // .trim() owns whitespace. We assert on the collapsed substring.
    expect(collapseRepeats(input)).toContain(chunk);
    expect(collapseRepeats(input)).not.toContain(`${chunk} ${chunk}`);
  });

  it("does not eat short stylistic repetition", () => {
    expect(collapseRepeats("ха ха ха ха")).toBe("ха ха ха ха");
    expect(collapseRepeats("no no no no no no")).toBe("no no no no no no");
  });

  it("preserves Ukrainian + Latin code-switching with prompts", () => {
    const input = "запушити PR і смерджити branch — це найкраще.";
    expect(collapseRepeats(input)).toBe(input);
  });

  it("handles multi-line text without losing newlines on unique content", () => {
    const input = "перший рядок який ніде не повторюється\nдругий рядок теж унікальний";
    expect(collapseRepeats(input)).toBe(input);
  });

  it("converges in finite passes on nested repeats", () => {
    const chunk = "a chunk that is comfortably above the threshold";
    const input = `${chunk} ${chunk} ${chunk} ${chunk} ${chunk}`;
    expect(collapseRepeats(input)).toBe(chunk);
  });
});
