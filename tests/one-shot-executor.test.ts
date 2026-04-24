import { describe, it, expect } from "vitest";

import { OneShotExecutor } from "../agent/core/one-shot-executor.ts";
import type { ToolExecutionResult, ToolName } from "../agent/core/protocol.ts";

type AskStub = (prompt: string) => Promise<string>;

/**
 * Minimal scripted bridge that hands back a queue of responses. Each call to
 * ask() pops the next response and records the prompt it was called with.
 */
function scriptedBridge(responses: string[]): { ask: AskStub; prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;
  return {
    prompts,
    ask: async (prompt: string) => {
      prompts.push(prompt);
      const next = responses[index++];
      if (next === undefined) throw new Error("Bridge ran out of scripted responses");
      return next;
    }
  };
}

/** Inline Toolbox stand-in — simpler than booting the real FS/shell sandbox. */
function fakeToolbox(
  handlers: Partial<Record<ToolName, (input: Record<string, unknown>) => ToolExecutionResult>>
): Parameters<typeof OneShotExecutor.prototype.constructor>[1] {
  return {
    async execute(tool: ToolName, input: Record<string, unknown>): Promise<ToolExecutionResult> {
      const handler = handlers[tool];
      if (!handler) {
        throw new Error(`fakeToolbox: no handler for ${tool}`);
      }
      return handler(input);
    }
  } as unknown as Parameters<typeof OneShotExecutor.prototype.constructor>[1];
}

describe("OneShotExecutor (iterative)", () => {
  it("returns the summary from the FINAL turn, not the first plan (#74)", async () => {
    // Round 1: plan to read a file (this would have been the old "final" answer).
    // Round 2: after receiving file contents, write the real answer.
    const bridge = scriptedBridge([
      JSON.stringify({
        commands: [{ tool: "read_file", input: { path: "/tmp/doc.docx" } }],
        summary: "Reading the DOCX file…"
      }),
      JSON.stringify({
        commands: [],
        summary: "Andrii's obligations: 1) deliver by deadline, 2) confidentiality, 3) compliance."
      })
    ]);

    const tools = fakeToolbox({
      read_file: () => ({
        ok: true,
        tool: "read_file",
        summary: "Read file /tmp/doc.docx",
        data: { path: "/tmp/doc.docx", content: "ICA Agreement. Contractor obligations: deadline, NDA, compliance." }
      })
    });

    const executor = new OneShotExecutor(bridge, tools, {
      availableTools: ["read_file"],
      workspaceRoot: "/tmp",
      unrestricted: true
    });

    const result = await executor.execute("what are Andrii's obligations");
    expect(result).toContain("Andrii's obligations");
    expect(result).not.toBe("Reading the DOCX file…");
    expect(bridge.prompts).toHaveLength(2);
  });

  it("feeds tool result content back into the follow-up prompt", async () => {
    const bridge = scriptedBridge([
      JSON.stringify({
        commands: [{ tool: "read_file", input: { path: "/tmp/x" } }],
        summary: "reading"
      }),
      JSON.stringify({ commands: [], summary: "final" })
    ]);

    const tools = fakeToolbox({
      read_file: () => ({
        ok: true,
        tool: "read_file",
        summary: "Read file /tmp/x",
        data: { path: "/tmp/x", content: "THE SECRET PAYLOAD" }
      })
    });

    const executor = new OneShotExecutor(bridge, tools, {
      availableTools: ["read_file"],
      workspaceRoot: "/tmp",
      unrestricted: true
    });

    await executor.execute("read it");
    // The second bridge call must include the file content so the model can
    // reason about it.
    expect(bridge.prompts[1]).toContain("THE SECRET PAYLOAD");
  });

  it("terminates immediately when the model returns empty commands (no-tool question)", async () => {
    const bridge = scriptedBridge([
      JSON.stringify({ commands: [], summary: "2 + 2 = 4" })
    ]);

    const executor = new OneShotExecutor(bridge, fakeToolbox({}), {
      availableTools: [],
      workspaceRoot: "/tmp",
      unrestricted: true
    });

    const result = await executor.execute("what is 2 + 2");
    expect(result).toBe("2 + 2 = 4");
    expect(bridge.prompts).toHaveLength(1);
  });

  it("honours the iteration cap and returns the last known summary", async () => {
    // Model keeps asking for tools forever — never converges.
    const infinitePlans = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({
        commands: [{ tool: "read_file", input: { path: `/tmp/${i}` } }],
        summary: `iteration ${i}`
      })
    );
    const bridge = scriptedBridge(infinitePlans);

    const tools = fakeToolbox({
      read_file: () => ({
        ok: true,
        tool: "read_file",
        summary: "noop",
        data: { path: "noop", content: "" }
      })
    });

    const executor = new OneShotExecutor(bridge, tools, {
      availableTools: ["read_file"],
      workspaceRoot: "/tmp",
      unrestricted: true,
      maxIterations: 3
    });

    const result = await executor.execute("spin forever");
    expect(result).toContain("iteration"); // picked up the last plan summary
    expect(bridge.prompts).toHaveLength(3);
  });

  it("surfaces tool failures to the model instead of aborting", async () => {
    const bridge = scriptedBridge([
      JSON.stringify({
        commands: [{ tool: "read_file", input: { path: "/nope" } }],
        summary: "trying"
      }),
      JSON.stringify({ commands: [], summary: "File was missing; reported limitation." })
    ]);

    const tools = fakeToolbox({
      read_file: () => {
        throw new Error("ENOENT: no such file");
      }
    });

    const executor = new OneShotExecutor(bridge, tools, {
      availableTools: ["read_file"],
      workspaceRoot: "/tmp",
      unrestricted: true
    });

    const result = await executor.execute("read a nonexistent file");
    expect(result).toBe("File was missing; reported limitation.");
    // Follow-up prompt must contain the failure so the model can react.
    expect(bridge.prompts[1]).toMatch(/ENOENT|failed|Failed/);
  });
});
