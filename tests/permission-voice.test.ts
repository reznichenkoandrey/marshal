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
  voiceQuestions,
  matchMultiAnswer,
  matchVoiceAnswer,
  answerChoices,
  parseElicitationRequest,
  describeElicitation,
  elicitationHookOutput,
  type PermissionRequest,
  type VoiceQuestion
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
    for (const text of ["", "Відкрий перекладач", "Хм", "так от я думаю що можна було б зробити інакше",
      "у нас була задача три дні тому яку ми не закінчили"]) {
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

describe("voiceQuestions", () => {
  it("takes one single-select choice question", () => {
    expect(voiceQuestions(ask([colour]))).toEqual([{ question: colour.question, labels: ["Red", "Blue sky", "Blue"], multiSelect: false }]);
  });

  it("takes up to three single-select questions in order", () => {
    const shape = { question: "Size?", options: [{ label: "S" }, { label: "M" }] };
    expect(voiceQuestions(ask([colour, shape]))).toEqual([
      { question: colour.question, labels: ["Red", "Blue sky", "Blue"], multiSelect: false },
      { question: "Size?", labels: ["S", "M"], multiSelect: false }
    ]);
    expect(voiceQuestions(ask([colour, shape, shape, shape]))).toBeNull();
  });

  it("takes multi-select questions too, marked as such", () => {
    expect(voiceQuestions(ask([{ ...colour, multiSelect: true }]))).toEqual([
      { question: colour.question, labels: ["Red", "Blue sky", "Blue"], multiSelect: true }
    ]);
  });

  it("leaves free text and empty calls to the session", () => {
    expect(voiceQuestions(ask([{ question: "Name?", kind: "text" }]))).toBeNull();
    expect(voiceQuestions(ask([]))).toBeNull();
    expect(voiceQuestions(request("Bash", { command: "ls" }))).toBeNull();
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
  const shape = { question: "Size?", options: [{ label: "S" }, { label: "M" }] };

  it("answers every question of the same call through updatedInput", () => {
    const req = ask([colour, shape]);
    const qs = voiceQuestions(req)!;
    expect(JSON.parse(questionHookOutput(req, qs, [[1], [0]]))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: { questions: [colour, shape], answers: { [colour.question]: "Blue sky", "Size?": "S" } }
        }
      }
    });
  });

  it("prints nothing unless every question has an answer", () => {
    const req = ask([colour, shape]);
    const qs = voiceQuestions(req)!;
    expect(questionHookOutput(req, qs, [[1], null])).toBe("");
    expect(questionHookOutput(req, qs, [[1]])).toBe("");
  });
});

describe("matchMultiAnswer", () => {
  const labels = ["Red", "Blue sky", "Blue", "Green"];

  it("takes every option named, by number, ordinal or label", () => {
    expect(matchMultiAnswer("перший і третій", labels)).toEqual([0, 2]);
    expect(matchMultiAnswer("Red and Green", labels)).toEqual([0, 3]);
    expect(matchMultiAnswer("два та чотири", labels)).toEqual([1, 3]);
  });

  it("takes a single option too", () => {
    expect(matchMultiAnswer("Green", labels)).toEqual([3]);
  });

  it("refuses 'all', nothing named, a no, or a long answer", () => {
    expect(matchMultiAnswer("усі три", labels)).toBeNull();
    expect(matchMultiAnswer("both", labels)).toBeNull();
    expect(matchMultiAnswer("ні", labels)).toBeNull();
    expect(matchMultiAnswer("Red, но не Green", labels)).toBeNull();
    expect(matchMultiAnswer("давай червоний і зелений і ще щось довге про це", labels)).toBeNull();
  });
});

describe("matchVoiceAnswer and answerChoices", () => {
  const single: VoiceQuestion = { question: "Colour?", labels: ["Red", "Blue"], multiSelect: false };
  const multi: VoiceQuestion = { ...single, multiSelect: true };

  it("keeps a single-select question to one option", () => {
    expect(matchVoiceAnswer("Red and Blue", single)).toBeNull();
    expect(matchVoiceAnswer("Blue", single)).toEqual([1]);
    expect(answerChoices(single, [1])).toBe("Blue");
    expect(answerChoices(single, [0, 1])).toBeNull();
  });

  it("joins several picks for a multi-select answer", () => {
    expect(matchVoiceAnswer("Red and Blue", multi)).toEqual([0, 1]);
    expect(answerChoices(multi, [0, 1])).toBe("Red, Blue");
    expect(answerChoices(multi, null)).toBeNull();
  });
});

describe("parseElicitationRequest", () => {
  const raw = (extra: Record<string, unknown>) => JSON.stringify({
    hook_event_name: "Elicitation",
    session_id: "e1",
    cwd: "/htdocs/marshal",
    mcp_server_name: "github",
    message: "Create the issue now?",
    requested_schema: { type: "object", properties: {} },
    ...extra
  });

  it("reads a pure confirmation (no fields to fill)", () => {
    expect(parseElicitationRequest(raw({}))).toEqual({
      sessionId: "e1",
      cwd: "/htdocs/marshal",
      server: "github",
      message: "Create the issue now?"
    });
  });

  it("leaves forms, other events and empty messages to the session", () => {
    const form = { properties: { title: { type: "string" } } };
    expect(parseElicitationRequest(raw({ requested_schema: form }))).toBeNull();
    expect(parseElicitationRequest(raw({ message: "" }))).toBeNull();
    expect(parseElicitationRequest(raw({ hook_event_name: "PermissionRequest" }))).toBeNull();
    expect(parseElicitationRequest("not json")).toBeNull();
  });
});

describe("describeElicitation and elicitationHookOutput", () => {
  const req = { sessionId: "e1", cwd: "/x", server: "github", message: "Create the issue now?" };

  it("says the request and the server briefly", () => {
    expect(describeElicitation("marshal", req, "en")).toBe("marshal (github) asks to confirm: Create the issue now? Allow?");
    expect(describeElicitation("marshal", req, "uk")).toBe("marshal (github) просить підтвердити: Create the issue now? Дозволити?");
  });

  it("accepts on a yes, declines on a no, prints nothing when unclear", () => {
    expect(JSON.parse(elicitationHookOutput("allow"))).toEqual({ hookSpecificOutput: { hookEventName: "Elicitation", action: "accept" } });
    expect(JSON.parse(elicitationHookOutput("deny"))).toEqual({ hookSpecificOutput: { hookEventName: "Elicitation", action: "decline" } });
    expect(elicitationHookOutput(null)).toBe("");
  });
});
