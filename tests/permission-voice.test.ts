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
  spokenSessionTitle,
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

const snoriq = { project: "Snoriq", title: "Аудит розрахунку нічних метрик" };
const bare = { project: "100-balloons_hyva", title: null };

describe("describePermission", () => {
  it("leads with the project and the session title, then the action in plain words", () => {
    expect(describePermission(snoriq, request("Bash", { command: "git push origin main" }), "uk"))
      .toBe("У проєкті Snoriq сесія «Аудит розрахунку нічних метрик» просить дозвіл запушити зміни. Дозволити?");
    expect(describePermission(bare, request("Bash", { command: "npm test" }), "uk"))
      .toBe("У проєкті 100 balloons hyva сесія просить дозвіл запустити тести. Дозволити?");
    expect(describePermission({ project: "marshal", title: "Voice wording" }, request("Bash", { command: "npm test" }), "en"))
      .toBe("In marshal, session “Voice wording” asks permission to run the tests. Allow?");
    expect(describePermission(bare, request("Bash", { command: "ls" }), "en"))
      .toBe("In 100 balloons hyva, a session asks permission to run ls. Allow?");
  });

  it("names known commands past cd, env and full paths", () => {
    const say = (command: string, description?: string) =>
      describePermission(bare, request("Bash", { command, ...(description ? { description } : {}) }), "uk");
    expect(say("cd ~/htdocs/x && FOO=1 /usr/bin/git push -u origin feature/a")).toContain("запушити зміни");
    expect(say("gh pr merge 12 --squash")).toContain("змерджити PR");
    expect(say("rm -rf dist")).toContain("видалити файли");
    expect(say("pnpm install")).toContain("встановити залежності");
    expect(say("curl -s https://example.com | jq .")).toContain("звернутися в інтернет");
    expect(say("./scripts/deploy.sh --prod", "Deploy to production")).toContain("виконати команду «Deploy to production»");
    expect(say("./scripts/deploy.sh --prod")).toContain("виконати команду deploy.sh");
  });

  it("says files, sites and MCP tools without ids or underscores", () => {
    const say = (tool: string, input: Record<string, unknown> = {}, lang: "uk" | "en" = "uk") => describePermission(bare, request(tool, input), lang);
    expect(say("Edit", { file_path: "/Users/me/htdocs/marshal/desktop/main.ts" })).toContain("просить дозвіл змінити файл main.ts.");
    expect(say("WebFetch", { url: "https://github.com/x/y" }, "en")).toContain("asks permission to open github.com.");
    expect(say("mcp__plugin_engineering_github__create_issue")).toContain("просить дозвіл створити issue у github.");
    expect(say("mcp__figma__get_design_context", {}, "en")).toContain("asks permission to look at design context in figma.");
    expect(say("mcp__figma__use_figma")).toContain("просить дозвіл скористатися figma.");
    expect(say("mcp__smart-browser__browser_click")).toContain("просить дозвіл керувати smart browser.");
    expect(say("mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch")).toContain("керувати програмою через конектор.");
    expect(say("mcp__a6baaa8f-e1b8-4b30-9612-3d2499af47c8__send_message")).toContain("просить дозвіл надіслати message.");
  });
});

describe("spokenSessionTitle", () => {
  it("says a human title, never a slug", () => {
    expect(spokenSessionTitle("Підготовка релізу проєкту", null)).toBe("Підготовка релізу проєкту");
    expect(spokenSessionTitle("cpap-ed", null)).toBeNull();
    expect(spokenSessionTitle(null, null)).toBeNull();
    expect(spokenSessionTitle("one two three four five six seven eight nine", null)).toBe("one two three four five six seven eight…");
  });

  it("falls back to the dossier's Feature line without branches and paths", () => {
    const dossier = "Project: marshal\nFeature: voice permission wording on feature/voice-permission-wording (#544)\nNow: tests";
    expect(spokenSessionTitle("fix_auth_flow", dossier)).toBe("voice permission wording on (#544)");
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
    expect(describeQuestion({ project: "marshal", title: null }, q, "en")).toBe("In marshal, a session asks: Which colour do you prefer for the badge? Options — 1: Red, 2: Blue.");
    expect(describeQuestion(snoriq, q, "uk")).toContain("У проєкті Snoriq сесія «Аудит розрахунку нічних метрик» питає:");
  });

  it("clips a long question", () => {
    const long = { question: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen", labels: ["a", "b"] };
    expect(describeQuestion(bare, long, "en")).toContain("twelve…");
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

  it("says the request briefly, project first", () => {
    expect(describeElicitation({ project: "marshal", title: null }, req, "en")).toBe("In marshal, a session asks to confirm: Create the issue now? Allow?");
    expect(describeElicitation(snoriq, req, "uk")).toBe("У проєкті Snoriq сесія «Аудит розрахунку нічних метрик» просить підтвердити: Create the issue now? Дозволити?");
  });

  it("accepts on a yes, declines on a no, prints nothing when unclear", () => {
    expect(JSON.parse(elicitationHookOutput("allow"))).toEqual({ hookSpecificOutput: { hookEventName: "Elicitation", action: "accept" } });
    expect(JSON.parse(elicitationHookOutput("deny"))).toEqual({ hookSpecificOutput: { hookEventName: "Elicitation", action: "decline" } });
    expect(elicitationHookOutput(null)).toBe("");
  });
});
