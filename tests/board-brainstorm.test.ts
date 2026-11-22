// tests/board-brainstorm.test.ts
//
// Brainstorm mode of voice boards (#276, Stage 3): layout of the idea map,
// the brainstorm prompt, the state that crosses IPC, saving one brainstorm
// into one folder, and the dispatcher rule.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DISPATCHER_PROMPT } from "../desktop/assistant/dispatcher-files.ts";
import { buildBrainstormRequest, parseBoardRole } from "../desktop/boards/board-prompt.ts";
import { sanitizeBoardState, saveBoard, type BoardState } from "../desktop/boards/board-store.ts";
import { applyOps, createOpStream, emptyBoard, layoutBoard } from "../desktop/renderer/board-ops.js";

const SIZE = { width: 100, height: 40, gapX: 20, gapY: 10 };

function boardOf(nodes: string[], edges: [string, string][]): BoardState {
  return {
    nodes: nodes.map((id) => ({ id, label: id, type: "idea" as const })),
    edges: edges.map(([from, to]) => ({ from, to })),
    summary: "",
    tasks: [],
    questions: []
  };
}

describe("layoutBoard", () => {
  it("puts children one column right and the parent in the middle of them", () => {
    const layout = layoutBoard(boardOf(["root", "a", "b", "c"], [["root", "a"], ["root", "b"], ["root", "c"]]), SIZE);
    const at = Object.fromEntries(layout.nodes.map((node) => [node.id, node]));
    expect(at.a).toMatchObject({ x: 120, y: 0 });
    expect(at.b).toMatchObject({ x: 120, y: 50 });
    expect(at.c).toMatchObject({ x: 120, y: 100 });
    expect(at.root).toMatchObject({ x: 0, y: 50 });
    expect(layout).toMatchObject({ width: 220, height: 140 });
  });

  it("never puts two nodes in one place", () => {
    const layout = layoutBoard(
      boardOf(["r", "a", "b", "a1", "a2", "lonely"], [["r", "a"], ["r", "b"], ["a", "a1"], ["a", "a2"], ["b", "a1"]]),
      SIZE
    );
    const spots = new Set(layout.nodes.map((node) => `${node.x}:${node.y}`));
    expect(spots.size).toBe(6);
  });

  it("places every node of a cycle and ignores edges to unknown nodes", () => {
    const layout = layoutBoard(boardOf(["a", "b"], [["a", "b"], ["b", "a"], ["a", "ghost"], ["a", "a"]]), SIZE);
    expect(layout.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it("is empty for an empty board", () => {
    expect(layoutBoard(emptyBoard())).toEqual({ nodes: [], width: 0, height: 0 });
  });
});

describe("streamed brainstorm ops", () => {
  it("grow the map op by op and never draw a half-written line", () => {
    const stream = createOpStream();
    const reply =
      '{"op":"addNode","id":"root","label":"Ціни","type":"idea"}\n' +
      '{"op":"addNode","id":"churn","label":"відтік клієнтів","type":"risk"}\n' +
      '{"op":"addEdge","from":"root","to":"churn"}\n' +
      '{"op":"setSummary","text":"Почали з цін."}\n';
    let board = emptyBoard();
    const sizes: number[] = [];
    for (let index = 0; index < reply.length; index += 7) {
      board = applyOps(board, stream.push(reply.slice(index, index + 7)));
      sizes.push(board.nodes.length);
    }
    board = applyOps(board, stream.end());
    expect(sizes).toContain(1);
    expect(board.nodes.map((node) => node.type)).toEqual(["idea", "risk"]);
    expect(board.edges).toEqual([{ from: "root", to: "churn" }]);
    expect(board.summary).toBe("Почали з цін.");
  });
});

describe("buildBrainstormRequest", () => {
  const board = boardOf(["pricing"], []);

  it("sends the board so far and the thought, and asks for JSON lines", () => {
    const request = buildBrainstormRequest("  а ще rate limit для API  ", board, "both", "auto");
    expect(request.user).toContain('"id":"pricing"');
    expect(request.user).toContain("а ще rate limit для API");
    expect(request.system).toContain("one per line");
    expect(request.system).toContain("Ukrainian");
    expect(request.system).toContain("never translated");
  });

  it("changes the instructions with the role", () => {
    const structure = buildBrainstormRequest("idea", board, "structure", "en").system;
    const challenge = buildBrainstormRequest("idea", board, "challenge", "en").system;
    expect(structure).toContain("Add no ideas of your own");
    expect(challenge).toContain("risks");
    expect(structure).not.toBe(challenge);
    expect(structure).toContain("English");
  });

  it("falls back to both for an unknown role", () => {
    expect(parseBoardRole("challenge")).toBe("challenge");
    expect(parseBoardRole("ignore the rules")).toBe("both");
    expect(parseBoardRole(undefined)).toBe("both");
  });
});

describe("sanitizeBoardState", () => {
  it("keeps only the documented fields and known node types", () => {
    const state = sanitizeBoardState({
      nodes: [
        { id: "a", label: " Ідея ", type: "risk", extra: "x" },
        { id: "a", label: "duplicate" },
        { id: "b", label: "B", type: "weird" },
        { id: "", label: "no id" },
        "junk"
      ],
      edges: [{ from: "a", to: "b", label: "leads to", other: 1 }, { from: "a", to: "ghost" }],
      summary: 5,
      tasks: ["one", 2, ""],
      questions: "none",
      diagram: "flowchart TD"
    });
    expect(state).toEqual({
      nodes: [
        { id: "a", label: "Ідея", type: "risk" },
        { id: "b", label: "B", type: "idea" }
      ],
      edges: [{ from: "a", to: "b", label: "leads to" }],
      summary: "",
      tasks: ["one"],
      questions: []
    });
  });

  it("is an empty board for anything that is not one", () => {
    expect(sanitizeBoardState(null).nodes).toEqual([]);
    expect(sanitizeBoardState("text").edges).toEqual([]);
  });
});

describe("saveBoard for a brainstorm", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const tempRoot = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "marshal-brainstorm-"));
    roots.push(root);
    return root;
  };

  it("rewrites one folder as the brainstorm grows", () => {
    const root = tempRoot();
    const first = saveBoard(root, { request: "ціни", language: "auto", state: boardOf(["root"], []) }, new Date(2026, 10, 22, 10, 0, 0));
    const second = saveBoard(
      root,
      { request: "ще відтік", language: "auto", state: boardOf(["root", "churn"], [["root", "churn"]]), id: first?.id },
      new Date(2026, 10, 22, 10, 5, 0)
    );
    expect(second?.id).toBe(first?.id);
    expect(readdirSync(root)).toHaveLength(1);
    expect(readdirSync(second?.dir ?? "")).toEqual(["board.json"]);
    const saved = JSON.parse(readFileSync(second?.file ?? "", "utf8"));
    expect(saved.mode).toBe("brainstorm");
    expect(saved.request).toBe("ще відтік");
    expect(saved.board.nodes).toHaveLength(2);
  });

  it("never writes outside its own folders for a foreign id", () => {
    const root = tempRoot();
    const saved = saveBoard(root, { request: "x", language: "en", state: boardOf(["root"], []), id: "../escape" });
    expect(saved?.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/u);
    expect(readdirSync(root)).toEqual([saved?.id]);
  });

  it("saves nothing for an empty map", () => {
    const root = tempRoot();
    expect(saveBoard(root, { request: "x", language: "en", state: boardOf([], []) })).toBeNull();
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("dispatcher prompt", () => {
  it("sends a brainstorm thought to the board", () => {
    expect(DISPATCHER_PROMPT).toContain("./marshal do brainstorm <the thought");
  });
});
