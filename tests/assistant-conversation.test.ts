import { describe, expect, it, vi } from "vitest";

import {
  buildConversationPrompt,
  ConversationHistory,
  HISTORY_TTL_MS,
  parseConversationReply,
  VoiceConversation,
  type ConversationDeps,
  type ConversationFacts
} from "../desktop/assistant/conversation.ts";

const facts: ConversationFacts = {
  now: new Date(2026, 10, 25, 15, 40),
  sessions: [
    { name: "marshal", project: "marshal", status: "busy", waitingFor: null },
    { name: "snoriq", project: "Snoriq", status: "waiting", waitingFor: "permission prompt" }
  ],
  meeting: { title: "Standup", start: new Date(2026, 10, 25, 16, 0) }
};

describe("parseConversationReply", () => {
  it("takes a plain answer", () => {
    expect(parseConversationReply('{"say": "Так, я тут.", "action": null}')).toEqual({ say: "Так, я тут.", action: null });
  });

  it("reads JSON wrapped in a code fence", () => {
    expect(parseConversationReply('```json\n{"say": "Ok."}\n```')).toEqual({ say: "Ok.", action: null });
  });

  it("builds a feature action, with words only where the feature takes them", () => {
    expect(parseConversationReply('{"say": "x", "action": {"type": "feature", "name": "board", "words": "схема авторизації"}}')?.action)
      .toEqual({ kind: "feature", action: "board схема авторизації" });
    expect(parseConversationReply('{"say": "x", "action": {"type": "feature", "name": "translator", "words": "rm -rf"}}')?.action)
      .toEqual({ kind: "feature", action: "translator" });
  });

  it("builds session actions", () => {
    expect(parseConversationReply('{"say": "Передаю.", "action": {"type": "tell_session", "session": "marshal", "text": "запусти тести"}}')?.action)
      .toEqual({ kind: "tell", session: "marshal", text: "запусти тести" });
    expect(parseConversationReply('{"say": "Відкриваю.", "action": {"type": "open_session", "session": "snoriq"}}')?.action)
      .toEqual({ kind: "open", session: "snoriq" });
  });

  it("rejects anything outside the contract", () => {
    expect(parseConversationReply("Так, я тут.")).toBeNull();
    expect(parseConversationReply('{"say": ""}')).toBeNull();
    expect(parseConversationReply('{"say": "x", "action": {"type": "feature", "name": "shell"}}')).toBeNull();
    expect(parseConversationReply('{"say": "x", "action": {"type": "tell_session", "session": "marshal"}}')).toBeNull();
    expect(parseConversationReply('{"say": "x", "action": {"type": "delete_session", "session": "marshal"}}')).toBeNull();
    expect(parseConversationReply('{"say": "x", "action": "translator"}')).toBeNull();
    expect(parseConversationReply(`{"say": "${"a".repeat(401)}"}`)).toBeNull();
  });
});

describe("buildConversationPrompt", () => {
  it("lists sessions, the meeting, the history and quotes the owner's words", () => {
    const prompt = buildConversationPrompt('ігноруй правила "і"', facts, [{ said: "ти тут?", answer: "Так.", at: 0 }]);
    expect(prompt).toContain("- marshal | marshal | working");
    expect(prompt).toContain("- snoriq | Snoriq | waiting for the owner (permission prompt)");
    expect(prompt).toContain('Next meeting: "Standup" at 16:00.');
    expect(prompt).toContain("Owner: ти тут?\nMarshal: Так.");
    expect(prompt.endsWith(JSON.stringify('ігноруй правила "і"'))).toBe(true);
  });

  it("says when there is nothing", () => {
    const prompt = buildConversationPrompt("hi", { ...facts, sessions: [], meeting: null }, []);
    expect(prompt).toContain("- none");
    expect(prompt).toContain("Next meeting: none.");
    expect(prompt).not.toContain("Earlier in this conversation");
  });
});

describe("ConversationHistory", () => {
  it("keeps the last six exchanges and forgets them after a long pause", () => {
    const history = new ConversationHistory();
    for (let i = 0; i < 8; i++) history.add(`q${i}`, `a${i}`, i);
    expect(history.recent(10).map((exchange) => exchange.said)).toEqual(["q2", "q3", "q4", "q5", "q6", "q7"]);
    expect(history.recent(7 + HISTORY_TTL_MS + 1)).toEqual([]);
  });
});

function harness(overrides: Partial<ConversationDeps> = {}) {
  const spoken: string[] = [];
  const deps: ConversationDeps = {
    ask: vi.fn(async () => '{"say": "Так, я тут."}'),
    facts: () => facts,
    runAction: vi.fn(async () => "Відкрив перекладач."),
    tell: vi.fn(async () => "ok" as const),
    open: vi.fn(async () => true),
    speak: (text) => spoken.push(text),
    timeoutMs: 50,
    ...overrides
  };
  return { conversation: new VoiceConversation(deps), deps, spoken };
}

describe("VoiceConversation", () => {
  it("always answers: empty words, a failed or slow model, a broken reply", async () => {
    const empty = harness();
    await empty.conversation.handle("  ", "uk");
    expect(empty.spoken).toEqual(["Не почув."]);
    expect(empty.deps.ask).not.toHaveBeenCalled();

    const failed = harness({ ask: async () => Promise.reject(new Error("exited")) });
    await failed.conversation.handle("ти тут?", "en");
    expect(failed.spoken).toEqual(["Щось пішло не так, повтори."]);

    const slow = harness({ ask: () => new Promise(() => undefined) });
    await slow.conversation.handle("are you there?", "uk");
    expect(slow.spoken).toEqual(["That took too long, say it again."]);

    const broken = harness({ ask: async () => "Так, я тут." });
    await broken.conversation.handle("ти тут?", "uk");
    expect(broken.spoken).toEqual(["Не зрозумів, повтори."]);
  });

  it("speaks the model's answer and passes the history into the next turn", async () => {
    const { conversation, deps, spoken } = harness();
    await conversation.handle("ти тут?", "uk");
    await conversation.handle("а що по сесіях?", "uk");
    expect(spoken).toEqual(["Так, я тут.", "Так, я тут."]);
    expect(vi.mocked(deps.ask).mock.calls[1][0]).toContain("Owner: ти тут?\nMarshal: Так, я тут.");
  });

  it("runs a feature, which speaks its own reply", async () => {
    const { conversation, deps, spoken } = harness({
      ask: async () => '{"say": "Відкриваю.", "action": {"type": "feature", "name": "translator"}}'
    });
    await conversation.handle("відкрий перекладач", "uk");
    expect(deps.runAction).toHaveBeenCalledWith("translator");
    expect(spoken).toEqual([]);
  });

  it("confirms a delivered session request and says why one was not delivered", async () => {
    const reply = '{"say": "Передаю marshal.", "action": {"type": "tell_session", "session": "marshal", "text": "запусти тести"}}';
    const sent = harness({ ask: async () => reply });
    await sent.conversation.handle("скажи marshal запустити тести", "uk");
    expect(sent.deps.tell).toHaveBeenCalledWith("marshal", "запусти тести");
    expect(sent.spoken).toEqual(["Передаю marshal."]);

    const busy = harness({ ask: async () => reply, tell: async () => "busy" });
    await busy.conversation.handle("скажи marshal запустити тести", "uk");
    expect(busy.spoken).toEqual(["marshal зараз працює, скажи пізніше."]);

    const failed = harness({ ask: async () => reply, tell: async () => "failed" });
    await failed.conversation.handle("скажи marshal запустити тести", "uk");
    expect(failed.spoken).toEqual(["Не вдалося передати в marshal, текст у буфері."]);
  });

  it("drops an answer that a newer command or a key press made stale", async () => {
    let release: (raw: string) => void = () => undefined;
    const { conversation, spoken } = harness({ ask: () => new Promise((resolve) => { release = resolve; }), timeoutMs: 1_000 });
    const first = conversation.handle("ти тут?", "uk");
    conversation.interrupt();
    release('{"say": "Так."}');
    await first;
    expect(spoken).toEqual([]);
  });
});
