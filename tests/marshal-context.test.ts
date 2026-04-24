import { describe, it, expect } from "vitest";

import { buildExecutionTask } from "../agent/runtime/marshal.ts";
import type { RuntimeAttachment, RuntimePriorMessage } from "../agent/runtime/types.ts";
import { collectPriorMessages } from "../operator/task-service.ts";
import type { OperatorMessage } from "../operator/types.ts";

function makeAttachment(id: string, name: string): RuntimeAttachment {
  return {
    id,
    name,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 42,
    relativePath: `uploads/${id}-${name}`,
    absolutePath: `/sessions/abc/workspace/uploads/${id}-${name}`,
    uploadedAt: "2026-04-24T10:00:00.000Z"
  };
}

describe("buildExecutionTask", () => {
  it("omits the history block when no prior messages are given (legacy behaviour)", () => {
    const prompt = buildExecutionTask(
      "what is in this file",
      "auto",
      [makeAttachment("a1", "doc.docx")],
      "/tmp",
      true,
      []
    );
    expect(prompt).not.toContain("Previous conversation");
    expect(prompt).toContain("what is in this file");
    expect(prompt).toContain("doc.docx");
    // Absolute path is now the canonical form — prior behaviour used relative.
    expect(prompt).toContain("/sessions/abc/workspace/uploads/a1-doc.docx");
  });

  it("prepends a history transcript when prior messages are given (#73)", () => {
    const attachment = makeAttachment("att-1", "ICA.docx");
    const prior: RuntimePriorMessage[] = [
      { role: "user", text: "give me a summary", attachments: [attachment] },
      { role: "assistant", text: "It's an Independent Contractor Agreement …", attachments: [] }
    ];

    const prompt = buildExecutionTask(
      "list the rules for the contractor",
      "auto",
      [],
      "/tmp",
      true,
      prior
    );

    expect(prompt).toMatch(/Previous conversation/);
    expect(prompt).toMatch(/User \(turn 1\):/);
    expect(prompt).toMatch(/give me a summary/);
    expect(prompt).toMatch(/\[User attached: ICA\.docx\]/);
    expect(prompt).toMatch(/Assistant \(turn 1\):/);
    expect(prompt).toMatch(/Independent Contractor Agreement/);
    expect(prompt).toMatch(/New message from user:\s+list the rules for the contractor/);
  });

  it("carries prior-turn attachments into the consolidated list with absolute paths", () => {
    const docA = makeAttachment("att-1", "ICA.docx");
    const docB = makeAttachment("att-2", "addendum.pdf");
    const prior: RuntimePriorMessage[] = [
      { role: "user", text: "summarise ICA", attachments: [docA] },
      { role: "assistant", text: "done", attachments: [] },
      { role: "user", text: "and the addendum", attachments: [docB] },
      { role: "assistant", text: "done", attachments: [] }
    ];

    const prompt = buildExecutionTask(
      "compare the two documents",
      "auto",
      [],
      "/tmp",
      true,
      prior
    );

    expect(prompt).toContain("/sessions/abc/workspace/uploads/att-1-ICA.docx");
    expect(prompt).toContain("/sessions/abc/workspace/uploads/att-2-addendum.pdf");
    // Both attachments listed once — no duplicates.
    const matches = prompt.match(/ICA\.docx/g) ?? [];
    expect(matches.filter((m) => m === "ICA.docx").length).toBeGreaterThanOrEqual(2); // once in history, once in attachments
  });

  it("dedupes attachments referenced in both prior and current turns by id", () => {
    const doc = makeAttachment("att-dup", "same.docx");
    const prior: RuntimePriorMessage[] = [
      { role: "user", text: "first", attachments: [doc] },
      { role: "assistant", text: "ok", attachments: [] }
    ];

    const prompt = buildExecutionTask(
      "re-ask with same attachment",
      "auto",
      [doc],
      "/tmp",
      true,
      prior
    );

    // The deduped consolidated attachment list has exactly one numbered entry.
    const listEntries = prompt.match(/^\d+\. same\.docx /gm) ?? [];
    expect(listEntries).toHaveLength(1);
    // …and exactly one "[User attached: same.docx]" line in the history.
    const historyMentions = prompt.match(/\[User attached: same\.docx\]/g) ?? [];
    expect(historyMentions).toHaveLength(1);
  });

  it("adds the browser/local route hint to the current message only, not to history", () => {
    const prior: RuntimePriorMessage[] = [
      { role: "user", text: "t1", attachments: [] },
      { role: "assistant", text: "r1", attachments: [] }
    ];

    const prompt = buildExecutionTask("do it", "browser", [], "/tmp", true, prior);
    const hintOccurrences = (prompt.match(/use browser tools only/g) ?? []).length;
    expect(hintOccurrences).toBe(1);
  });
});

describe("collectPriorMessages", () => {
  function makeMessage(overrides: Partial<OperatorMessage>): OperatorMessage {
    return {
      id: overrides.id ?? "msg-id",
      role: overrides.role ?? "user",
      text: overrides.text ?? "",
      createdAt: overrides.createdAt ?? "2026-04-24T10:00:00.000Z",
      route: overrides.route ?? null,
      taskId: overrides.taskId ?? null,
      attachments: overrides.attachments ?? []
    };
  }

  it("drops system messages", () => {
    const messages: OperatorMessage[] = [
      makeMessage({ id: "m-sys", role: "system", text: "boot" }),
      makeMessage({ id: "m-u1", role: "user", text: "hi", taskId: "t-1" }),
      makeMessage({ id: "m-a1", role: "assistant", text: "hey", taskId: "t-1" })
    ];

    const result = collectPriorMessages(messages, "t-current");
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("drops the current task's own user message (already sent as the fresh prompt)", () => {
    const messages: OperatorMessage[] = [
      makeMessage({ id: "m-u1", role: "user", text: "turn 1", taskId: "t-1" }),
      makeMessage({ id: "m-a1", role: "assistant", text: "reply 1", taskId: "t-1" }),
      makeMessage({ id: "m-u2", role: "user", text: "turn 2 current", taskId: "t-2" })
    ];

    const result = collectPriorMessages(messages, "t-2");
    expect(result.map((m) => m.text)).toEqual(["turn 1", "reply 1"]);
  });

  it("returns an empty list for the first task in a session", () => {
    const messages: OperatorMessage[] = [
      makeMessage({ id: "m-sys", role: "system", text: "boot" }),
      makeMessage({ id: "m-u1", role: "user", text: "first message", taskId: "t-1" })
    ];

    const result = collectPriorMessages(messages, "t-1");
    expect(result).toEqual([]);
  });

  it("preserves attachment references so the new prompt can re-list them", () => {
    const attachment = {
      id: "a1",
      name: "file.docx",
      mimeType: "application/msword",
      size: 10,
      relativePath: "uploads/a1-file.docx",
      absolutePath: "/abs/uploads/a1-file.docx",
      uploadedAt: "2026-04-24T00:00:00.000Z"
    };
    const messages: OperatorMessage[] = [
      makeMessage({ id: "m-u1", role: "user", text: "upload", taskId: "t-1", attachments: [attachment] })
    ];

    const result = collectPriorMessages(messages, "t-2");
    expect(result[0].attachments).toEqual([attachment]);
  });
});
