import { describe, expect, it } from "vitest";

import { describeWaiting, isQuestionWait, speakableProject } from "../desktop/assistant/waiting-speech.ts";
import { SpeechQueue } from "../desktop/speech/speech-policy.ts";

describe("isQuestionWait", () => {
  it("tells a question or a plan from a permission", () => {
    // AskUserQuestion in the terminal: generic message, only the registry knows.
    expect(isQuestionWait({ confirmation: true, message: "Claude needs your permission", waitingFor: "input needed" })).toBe(true);
    expect(isQuestionWait({ confirmation: true, message: "Claude needs your permission to use AskUserQuestion", waitingFor: null })).toBe(true);
    expect(isQuestionWait({ confirmation: true, message: "Claude Code needs your approval for the plan", waitingFor: "permission prompt" })).toBe(true);
    expect(isQuestionWait({ confirmation: false, message: "An MCP server needs your input", waitingFor: null })).toBe(true);
    expect(isQuestionWait({ confirmation: true, message: "Claude needs your permission to use Bash", waitingFor: "permission prompt" })).toBe(false);
    expect(isQuestionWait({ confirmation: true, message: "Claude needs your permission", waitingFor: null })).toBe(false);
  });
});

describe("speakableProject", () => {
  it("reads separators as spaces", () => {
    expect(speakableProject("100-balloons")).toBe("100 balloons");
    expect(speakableProject("snoriq_redesign-v1")).toBe("snoriq redesign v1");
    expect(speakableProject("marshal")).toBe("marshal");
  });
});

describe("describeWaiting", () => {
  it("groups by project with Ukrainian numerals that agree", () => {
    expect(describeWaiting([
      { project: "marshal", question: true },
      { project: "marshal", question: true },
      { project: "100-balloons", question: false }
    ], "uk")).toBe("У проєкті marshal дві сесії чекають відповіді. У проєкті 100 balloons одна сесія чекає дозволу.");
    const five = Array.from({ length: 5 }, () => ({ project: "x", question: false }));
    expect(describeWaiting(five, "uk")).toBe("У проєкті x п'ять сесій чекають дозволу.");
    const eleven = Array.from({ length: 11 }, () => ({ project: "x", question: true }));
    expect(describeWaiting(eleven, "uk")).toBe("У проєкті x 11 сесій чекають відповіді.");
    const twentyOne = Array.from({ length: 21 }, () => ({ project: "x", question: true }));
    expect(describeWaiting(twentyOne, "uk")).toBe("У проєкті x 21 сесія чекає відповіді.");
  });

  it("says both kinds in one project, and English", () => {
    expect(describeWaiting([{ project: "marshal", question: true }, { project: "marshal", question: false }], "uk"))
      .toBe("У проєкті marshal одна сесія чекає відповіді, одна сесія чекає дозволу.");
    expect(describeWaiting([{ project: "marshal", question: true }, { project: "marshal", question: true }, { project: "snoriq", question: false }], "en"))
      .toBe("In marshal, two sessions need an answer. In snoriq, one session needs permission.");
  });
});

describe("SpeechQueue.has", () => {
  it("reports a queued key until it is taken", () => {
    const queue = new SpeechQueue();
    queue.enqueue({ text: "a", lang: "uk", key: "session:waiting" });
    expect(queue.has("session:waiting")).toBe(true);
    queue.take();
    expect(queue.has("session:waiting")).toBe(false);
  });
});
