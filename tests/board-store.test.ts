// tests/board-store.test.ts
//
// Saved boards (#276, Stage 2): `board.mmd` and `board.json` per drawn diagram,
// pruning of the oldest, and the dispatcher rule that sends a spoken request
// to the board.

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DISPATCHER_PROMPT } from "../desktop/assistant/dispatcher-files.ts";
import { boardId, planBoardPrune, saveBoard } from "../desktop/boards/board-store.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "marshal-boards-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SOURCE = 'flowchart TD\n  a["Початок"] --> b["deploy"]';

describe("saveBoard", () => {
  it("writes the Mermaid source and what was asked", () => {
    const root = tempRoot();
    const saved = saveBoard(root, { request: " намалюй деплой ", source: `\n${SOURCE}\n`, language: "uk" }, new Date(2026, 10, 22, 9, 5, 7));
    expect(saved?.id).toMatch(/^20261122-090507-[0-9a-f]{4}$/u);
    expect(saved?.file).toBe(path.join(root, saved!.id, "board.mmd"));
    expect(readFileSync(saved!.file, "utf8")).toBe(`${SOURCE}\n`);
    const meta = JSON.parse(readFileSync(path.join(saved!.dir, "board.json"), "utf8"));
    expect(meta).toMatchObject({ id: saved!.id, request: "намалюй деплой", language: "uk" });
    expect(Number.isNaN(Date.parse(meta.savedAt))).toBe(false);
  });

  it("saves nothing for an empty or oversized source", () => {
    const root = tempRoot();
    expect(saveBoard(root, { request: "x", source: "  \n", language: "auto" })).toBeNull();
    expect(saveBoard(root, { request: "x", source: "a".repeat(20_001), language: "auto" })).toBeNull();
    expect(readdirSync(root)).toEqual([]);
  });

  it("prunes the oldest boards and leaves foreign folders alone", () => {
    const root = tempRoot();
    for (let hour = 0; hour < 100; hour++) {
      mkdirSync(path.join(root, boardId(new Date(2026, 0, 1 + Math.floor(hour / 24), hour % 24), "aaaa")));
    }
    mkdirSync(path.join(root, "kept-by-owner"));
    writeFileSync(path.join(root, "notes.txt"), "mine");
    const saved = saveBoard(root, { request: "", source: SOURCE, language: "auto" }, new Date(2026, 5, 1));
    const names = readdirSync(root);
    expect(names).toContain(saved!.id);
    expect(names).toContain("kept-by-owner");
    expect(names).toContain("notes.txt");
    expect(names).not.toContain("20260101-000000-aaaa");
    expect(names.filter((name) => /^\d{8}-/u.test(name))).toHaveLength(100);
  });
});

describe("planBoardPrune", () => {
  it("returns only its own ids, oldest first", () => {
    const names = ["20260103-000000-aaaa", "other", "20260101-000000-aaaa", "20260102-000000-aaaa", "../x"];
    expect(planBoardPrune(names, 1)).toEqual(["20260101-000000-aaaa", "20260102-000000-aaaa"]);
    expect(planBoardPrune(names, 5)).toEqual([]);
  });
});

describe("voice entry", () => {
  it("the dispatcher sends a drawing request to the board, in the owner's words", () => {
    expect(DISPATCHER_PROMPT).toContain("./marshal do board <what to draw");
    expect(DISPATCHER_PROMPT).toContain("./marshal do board-close");
    expect(DISPATCHER_PROMPT).toContain("намалюй схему");
  });
});
