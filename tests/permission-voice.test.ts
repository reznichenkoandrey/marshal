import { describe, expect, it } from "vitest";

import {
  classifyPermissionAnswer,
  describePermission,
  parsePermissionRequest,
  permissionHookOutput,
  type PermissionRequest
} from "../desktop/claude-code/permission-voice.ts";

const request = (toolName: string, toolInput: Record<string, unknown>): PermissionRequest => ({
  sessionId: "s1",
  cwd: "/htdocs/marshal",
  toolName,
  toolInput
});

describe("parsePermissionRequest", () => {
  it("reads the PermissionRequest payload of Claude Code 2.1.322", () => {
    const raw = JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "abc",
      cwd: "/htdocs/marshal",
      tool_name: "Bash",
      tool_input: { command: "npm test", description: "Run tests" },
      permission_suggestions: []
    });
    expect(parsePermissionRequest(raw)).toEqual({
      sessionId: "abc",
      cwd: "/htdocs/marshal",
      toolName: "Bash",
      toolInput: { command: "npm test", description: "Run tests" }
    });
  });

  it("ignores other events and broken JSON", () => {
    expect(parsePermissionRequest(JSON.stringify({ hook_event_name: "Stop", session_id: "a" }))).toBeNull();
    expect(parsePermissionRequest("{")).toBeNull();
  });
});

describe("describePermission", () => {
  it("names the action briefly, without paths", () => {
    expect(describePermission("marshal", request("Bash", { command: "npm test", description: "Run tests" }), "uk"))
      .toBe("marshal хоче запустити: Run tests. Дозволити?");
    expect(describePermission("marshal", request("Bash", { command: "/usr/bin/git push origin feature/a b c d e f" }), "en"))
      .toBe("marshal wants to run git push origin a b c. Allow?");
    expect(describePermission("marshal", request("Edit", { file_path: "/Users/me/htdocs/marshal/desktop/main.ts" }), "uk"))
      .toBe("marshal хоче змінити main.ts. Дозволити?");
    expect(describePermission("marshal", request("WebFetch", { url: "https://github.com/x/y" }), "en"))
      .toBe("marshal wants to open github.com. Allow?");
    expect(describePermission("snoriq", request("mcp__figma__use_figma", {}), "uk"))
      .toBe("snoriq хоче викликати use_figma з figma. Дозволити?");
  });
});

describe("classifyPermissionAnswer", () => {
  it("allows on a short yes", () => {
    for (const text of ["Так.", "Так, давай", "Дозволяю!", "ок", "Yes, go ahead.", "sure"]) {
      expect(classifyPermissionAnswer(text), text).toBe("allow");
    }
  });

  it("denies on any no, even next to a yes", () => {
    for (const text of ["Ні.", "Не треба", "Так, але не зараз", "No.", "Stop, wait", "Ні, давай інакше"]) {
      expect(classifyPermissionAnswer(text), text).toBe("deny");
    }
  });

  it("decides nothing on unclear or long answers", () => {
    for (const text of ["", "Відкрий перекладач", "Хм", "так от я думаю що можна було б зробити інакше"]) {
      expect(classifyPermissionAnswer(text), text).toBeNull();
    }
  });
});

describe("permissionHookOutput", () => {
  it("prints the decision Claude Code expects, or nothing", () => {
    expect(JSON.parse(permissionHookOutput("allow"))).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } }
    });
    expect(JSON.parse(permissionHookOutput("deny")).hookSpecificOutput.decision.behavior).toBe("deny");
    expect(permissionHookOutput(null)).toBe("");
  });
});
