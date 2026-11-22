// tests/board-ops.test.ts
//
// Pure core of voice boards (#276): the op stream parser, op application, the
// one-repair-retry flow and the prompts. Mermaid itself runs only in the board
// window; tests/e2e/board.mjs checks the same fixtures against the real parser.

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  applyOp,
  applyOps,
  createOpStream,
  diagramFromReply,
  directOps,
  emptyBoard,
  normalizeOp,
  parseOps,
  resolveDiagram
} from "../desktop/renderer/board-ops.js";
import {
  askBoardModel,
  buildBoardRequest,
  buildRepairRequest,
  parseBoardLanguage
} from "../desktop/boards/board-prompt.ts";

const quoting = JSON.parse(readFileSync(new URL("./fixtures/boards/quoting.json", import.meta.url), "utf8")) as {
  valid: { name: string; source: string }[];
  broken: { name: string; source: string }[];
};

describe("op stream", () => {
  it("returns an op only when its line is complete", () => {
    const stream = createOpStream();
    expect(stream.push('{"op":"addNode","id":"cache","la')).toEqual([]);
    expect(stream.push('bel":"кеш","type":"risk"}')).toEqual([]);
    expect(stream.push("\n")).toEqual([{ op: "addNode", id: "cache", label: "кеш", type: "risk" }]);
  });

  it("splits several ops in one chunk and keeps the unfinished tail", () => {
    const stream = createOpStream();
    const ops = stream.push('{"op":"setSummary","text":"a"}\r\n{"op":"removeNode","id":"x"}\n{"op":"setSu');
    expect(ops.map((op) => op.op)).toEqual(["setSummary", "removeNode"]);
    expect(stream.end()).toEqual([]);
    expect(stream.dropped).toHaveLength(1);
  });

  it("turns a closed mermaid fence into one setDiagram and never emits an open one", () => {
    const stream = createOpStream();
    expect(stream.push("Here you go:\n```mermaid\nflowchart TD\n  a --> b\n")).toEqual([]);
    expect(stream.push("```\n")).toEqual([{ op: "setDiagram", mermaid: "flowchart TD\n  a --> b" }]);
    const open = createOpStream();
    open.push("```mermaid\nflowchart TD\n  a --> b");
    expect(open.end()).toEqual([]);
  });

  it("drops unknown and malformed ops without failing, and ignores prose", () => {
    const { ops, dropped } = parseOps(
      ['{"op":"explode"}', "{not json}", "just text", '{"op":"addNode","id":"a"}', '{"op":"setTasks","items":["x"]}'].join("\n")
    );
    expect(ops).toEqual([{ op: "setTasks", items: ["x"] }]);
    expect(dropped).toHaveLength(3);
  });

  it("takes the last line without a newline once the stream ends", () => {
    expect(parseOps('{"op":"setSummary","text":"done"}').ops).toEqual([{ op: "setSummary", text: "done" }]);
  });
});

describe("normalizeOp", () => {
  it("keeps only documented fields and defaults the node type", () => {
    expect(normalizeOp({ op: "addNode", id: " a ", label: "A", type: "banana", evil: 1 })).toEqual({
      op: "addNode",
      id: "a",
      label: "A",
      type: "idea"
    });
    expect(normalizeOp({ op: "setQuestions", items: ["q", 3, " "] })).toEqual({ op: "setQuestions", items: ["q"] });
    expect(normalizeOp({ op: "setDiagram", mermaid: "  " })).toBeNull();
    expect(normalizeOp([])).toBeNull();
  });
});

describe("applyOp", () => {
  const seeded = applyOps(emptyBoard(), [
    { op: "addNode", id: "a", label: "A", type: "idea" },
    { op: "addNode", id: "b", label: "B", type: "task" },
    { op: "addEdge", from: "a", to: "b" }
  ]);

  it("treats a duplicate addNode id as an update in place", () => {
    const next = applyOp(seeded, { op: "addNode", id: "a", label: "A2", type: "risk" });
    expect(next.nodes).toEqual([
      { id: "a", label: "A2", type: "risk" },
      { id: "b", label: "B", type: "task" }
    ]);
  });

  it("updates only the given fields and ignores an unknown node", () => {
    expect(applyOp(seeded, { op: "updateNode", id: "b", label: "B2" }).nodes[1]).toEqual({ id: "b", label: "B2", type: "task" });
    expect(applyOp(seeded, { op: "updateNode", id: "zzz", label: "?" })).toBe(seeded);
  });

  it("removes a node together with its edges", () => {
    const next = applyOp(seeded, { op: "removeNode", id: "a" });
    expect(next.nodes.map((node) => node.id)).toEqual(["b"]);
    expect(next.edges).toEqual([]);
  });

  it("refuses an edge to a missing node and replaces a repeated edge", () => {
    expect(applyOp(seeded, { op: "addEdge", from: "a", to: "nope" })).toBe(seeded);
    const next = applyOp(seeded, { op: "addEdge", from: "a", to: "b", label: "then" });
    expect(next.edges).toEqual([{ from: "a", to: "b", label: "then" }]);
    expect(applyOp(next, { op: "removeEdge", from: "a", to: "b" }).edges).toEqual([]);
  });

  it("sets summary, tasks, questions and the diagram, without mutating the input", () => {
    const next = applyOps(seeded, [
      { op: "setSummary", text: "s" },
      { op: "setTasks", items: ["t"] },
      { op: "setQuestions", items: ["q"] },
      { op: "setDiagram", mermaid: "flowchart TD" }
    ]);
    expect(next).toMatchObject({ summary: "s", tasks: ["t"], questions: ["q"], diagram: "flowchart TD" });
    expect(seeded).toMatchObject({ summary: "", tasks: [], diagram: "" });
    expect(applyOp(seeded, { op: "whatever" })).toBe(seeded);
  });
});

describe("directOps", () => {
  it("accepts op lines, a fenced block and bare Mermaid; a plain request goes to the model", () => {
    expect(directOps('{"op":"setSummary","text":"x"}')).toHaveLength(1);
    expect(directOps("```mermaid\nflowchart TD\n a-->b\n```")).toEqual([{ op: "setDiagram", mermaid: "flowchart TD\n a-->b" }]);
    expect(directOps("sequenceDiagram\n a->>b: hi")).toEqual([{ op: "setDiagram", mermaid: "sequenceDiagram\n a->>b: hi" }]);
    expect(directOps("намалюй схему авторизації")).toEqual([]);
    expect(directOps("graphql schema for users")).toEqual([]);
  });
});

describe("resolveDiagram", () => {
  const parse = async (source: string) => {
    if (source.includes("BAD")) throw new Error(`Parse error near ${source.slice(0, 8)}`);
  };

  it("does not call the model for a diagram that parses", async () => {
    const repair = vi.fn();
    expect(await resolveDiagram({ source: "flowchart TD", parse, repair })).toEqual({
      ok: true,
      source: "flowchart TD",
      repaired: false
    });
    expect(repair).not.toHaveBeenCalled();
  });

  it("sends the broken source and the error back once and takes the fenced fix", async () => {
    const repair = vi.fn(async () => "Fixed:\n```mermaid\nflowchart TD\n  a --> b\n```");
    const result = await resolveDiagram({ source: "BAD source", parse, repair });
    expect(result).toEqual({ ok: true, source: "flowchart TD\n  a --> b", repaired: true });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledWith("BAD source", "Parse error near BAD sour");
  });

  it("stops after the second failure — one retry, never a loop", async () => {
    const repair = vi.fn(async () => "BAD again");
    const result = await resolveDiagram({ source: "BAD source", parse, repair });
    expect(result).toEqual({ ok: false, error: "Parse error near BAD agai", repaired: true });
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("reports the first error when the model gives no fix or throws", async () => {
    for (const repair of [async () => null, async () => "  ", async () => Promise.reject(new Error("offline"))]) {
      expect(await resolveDiagram({ source: "BAD source", parse, repair })).toEqual({
        ok: false,
        error: "Parse error near BAD sour",
        repaired: false
      });
    }
  });

  it("reads a bare reply and a setDiagram op as the diagram", () => {
    expect(diagramFromReply("  flowchart TD\n a-->b ")).toBe("flowchart TD\n a-->b");
    expect(diagramFromReply('{"op":"setDiagram","mermaid":"gantt"}')).toBe("gantt");
  });
});

describe("board prompts", () => {
  it("names the request language and keeps syntax English", () => {
    const uk = buildBoardRequest("намалюй схему авторизації", "auto");
    const en = buildBoardRequest("draw the deploy flow", "auto");
    expect(uk.system).toContain("in Ukrainian");
    expect(en.system).toContain("in English");
    // Same rules in both languages: only the label language differs.
    expect(uk.system.replace("Ukrainian", "English")).toBe(en.system);
    expect(en.system).toContain("keywords and node ids are always English");
    expect(en.system).toContain('id["label"]');
    expect(en.system).toContain("#quot;");
    expect(en.system).toContain("never translated");
  });

  it("lets the setting override the request language", () => {
    expect(buildBoardRequest("draw the deploy flow", "uk").system).toContain("in Ukrainian");
    expect(buildBoardRequest("намалюй деплой", "en").system).toContain("in English");
    expect(parseBoardLanguage("uk")).toBe("uk");
    expect(parseBoardLanguage("de")).toBe("auto");
    expect(parseBoardLanguage(undefined)).toBe("auto");
  });

  it("puts the error and the broken source into the repair request", () => {
    const repair = buildRepairRequest('flowchart TD\n  a[Скажи "привіт"]', "Parse error on line 2", "auto");
    expect(repair.user).toContain("Parse error on line 2");
    expect(repair.user).toContain('a[Скажи "привіт"]');
    expect(repair.system).toContain("in Ukrainian");
    expect(repair.timeoutMs).toBeGreaterThan(8000);
  });

  it("turns a silent model into an error the window can show", async () => {
    const request = buildBoardRequest("draw", "auto");
    expect(await askBoardModel(request, async () => null, "no model")).toEqual({ ok: false, error: "no model" });
    expect(await askBoardModel(request, async () => "  \n", "no model")).toEqual({ ok: false, error: "no model" });
    expect(await askBoardModel(request, async () => " ```mermaid\nx\n``` ", "no model")).toEqual({
      ok: true,
      text: "```mermaid\nx\n```"
    });
  });
});

describe("quoting fixtures", () => {
  it("cover every character the spec lists, each inside a quoted label", () => {
    const sources = quoting.valid.map((item) => item.source).join("\n");
    for (const needle of ["#quot;", "(", "[0]", ":", ";", "#276"]) expect(sources).toContain(needle);
    expect(sources).toMatch(/\p{Script=Cyrillic}/u);
    expect(quoting.broken.length).toBeGreaterThan(0);
  });
});
