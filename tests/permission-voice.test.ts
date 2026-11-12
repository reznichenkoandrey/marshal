import { describe, expect, it } from "vitest";

import {
  classifyPermissionAnswer,
  describePermission,
  describeQuestion,
  isVoicePermission,
  matchQuestionAnswer,
  parsePermissionRequest,
  permissionHookOutput,
  questionHookOutput,
  voiceQuestion,
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

const ask = (questions: unknown[]): PermissionRequest => request("AskUserQuestion", { questions });
const colour = {
  question: "Which colour do you prefer for the badge?",
  header: "Colour",
  multiSelect: false,
  options: [{ label: "Red", description: "warm" }, { label: "Blue sky" }, { label: "Blue" }]
};

describe("voiceQuestion", () => {
  it("takes one single-select choice question", () => {
    expect(voiceQuestion(ask([colour]))).toEqual({ question: colour.question, labels: ["Red", "Blue sky", "Blue"] });
  });

  it("leaves several questions, multi-select and free text to the session", () => {
    expect(voiceQuestion(ask([colour, colour]))).toBeNull();
    expect(voiceQuestion(ask([{ ...colour, multiSelect: true }]))).toBeNull();
    expect(voiceQuestion(ask([{ question: "Name?", kind: "text" }]))).toBeNull();
    expect(voiceQuestion(request("Bash", { command: "ls" }))).toBeNull();
  });

  it("keeps question tools out of the yes/no permission path", () => {
    expect(isVoicePermission(ask([colour]))).toBe(false);
    expect(isVoicePermission(request("ExitPlanMode", {}))).toBe(false);
    expect(isVoicePermission(request("Bash", { command: "ls" }))).toBe(true);
  });
});

describe("describeQuestion", () => {
  it("says the question and numbered options briefly", () => {
    const q = { question: colour.question, labels: ["Red", "Blue"] };
    expect(describeQuestion("marshal", q, "en")).toBe("marshal asks: Which colour do you prefer for the badge? Options — 1: Red, 2: Blue.");
    expect(describeQuestion("marshal", q, "uk")).toContain("marshal питає:");
  });

  it("clips a long question", () => {
    const long = { question: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen", labels: ["a", "b"] };
    expect(describeQuestion("s", long, "en")).toContain("twelve…");
  });
});

describe("matchQuestionAnswer", () => {
  const labels = ["Red", "Blue sky", "Blue"];

  it("matches a number or an ordinal in either language", () => {
    expect(matchQuestionAnswer("два", labels)).toBe(1);
    expect(matchQuestionAnswer("Давай варіант 3.", labels)).toBe(2);
    expect(matchQuestionAnswer("the first one", labels)).toBe(0);
    expect(matchQuestionAnswer("перший", labels)).toBe(0);
  });

  it("matches a label, longest first", () => {
    expect(matchQuestionAnswer("Blue sky please", labels)).toBe(1);
    expect(matchQuestionAnswer("blue", labels)).toBe(2);
    expect(matchQuestionAnswer("red", labels)).toBe(0);
  });

  it("agrees when the number and the label name the same option", () => {
    expect(matchQuestionAnswer("перший, red", labels)).toBe(0);
  });

  it("never guesses", () => {
    expect(matchQuestionAnswer("", labels)).toBeNull();
    expect(matchQuestionAnswer("red or blue", labels)).toBeNull();
    expect(matchQuestionAnswer("не перший", labels)).toBeNull();
    expect(matchQuestionAnswer("не знаю", labels)).toBeNull();
    expect(matchQuestionAnswer("так", labels)).toBeNull();
    expect(matchQuestionAnswer("п'ятий", labels)).toBeNull();
    expect(matchQuestionAnswer("four", labels)).toBeNull();
    expect(matchQuestionAnswer("I think maybe we should go with red here", labels)).toBeNull();
  });

  it("lets a label that is itself a no be chosen", () => {
    expect(matchQuestionAnswer("no", ["Yes", "No"])).toBe(1);
  });
});

describe("questionHookOutput", () => {
  it("answers the same call through updatedInput", () => {
    const req = ask([colour]);
    const q = voiceQuestion(req)!;
    expect(JSON.parse(questionHookOutput(req, q, 1))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: { questions: [colour], answers: { [colour.question]: "Blue sky" } } }
      }
    });
  });

  it("prints nothing without an answer", () => {
    const req = ask([colour]);
    expect(questionHookOutput(req, voiceQuestion(req)!, null)).toBe("");
  });
});
