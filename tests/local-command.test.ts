import { describe, expect, it } from "vitest";

import { describeSessionStatus, matchLocalCommand } from "../desktop/assistant/local-command.ts";

const action = (name: string) => ({ kind: "action", action: name });

describe("matchLocalCommand", () => {
  it.each([
    ["Маршал, відкрий перекладач.", "translator"],
    ["перекладач", "translator"],
    ["Open the translator, please", "translator"],
    ["Закрий перекладач", "translator-close"],
    ["увімкни субтитри", "captions"],
    ["Маршал, запиши дзвінок", "record-call"],
    ["зупини запис", "record-call"],
    ["запиши екран", "record-screen"],
    ["зроби скріншот", "capture"],
    ["Досить!", "skip"],
    ["stop talking", "skip"],
    ["відкрий налаштування", "settings"],
    ["яка наступна зустріч?", "next-meeting"],
    ["підключи мене до зустрічі", "join-meeting"],
    ["відкрий хаб", "hub"]
  ])("%s → %s", (text, name) => {
    expect(matchLocalCommand(text)).toEqual(action(name));
  });

  it("answers status and presence in the command's language", () => {
    expect(matchLocalCommand("Маршал, що там по сесіях?")).toEqual({ kind: "status", lang: "uk" });
    expect(matchLocalCommand("status")).toEqual({ kind: "status", lang: "en" });
    expect(matchLocalCommand("ти тут?")).toEqual({ kind: "presence", lang: "uk" });
    expect(matchLocalCommand("Marshal, are you there?")).toEqual({ kind: "presence", lang: "en" });
  });

  it.each([
    "відкрий перекладач і переклади цей лист",
    "переклади привіт англійською",
    "запусти тести в marshal",
    "що там у funky-rabbit",
    "скажи marshal, що досить",
    "відкрий дошку",
    "Маршал",
    "",
    "скрін\nScreenshot: /tmp/a.png"
  ])("leaves %j to the dispatcher", (text) => {
    expect(matchLocalCommand(text)).toBeNull();
  });
});

describe("describeSessionStatus", () => {
  const session = (project: string, status: string | null, waitingFor: string | null = null) => ({ project, status, waitingFor });

  it("says when nothing is open or everything is done", () => {
    expect(describeSessionStatus([], "uk")).toBe("Живих сесій немає.");
    expect(describeSessionStatus([session("marshal", "idle"), session("snoriq", "idle")], "uk")).toBe("Усі сесії готові.");
  });

  it("names questions, permissions and work before what is done, one state per project", () => {
    const sessions = [
      session("marshal", "idle"),
      session("funky-rabbit", "busy"),
      session("snoriq", "waiting", "input needed"),
      session("snoriq", "busy"),
      session("100_balloons", "waiting", "permission prompt")
    ];
    expect(describeSessionStatus(sessions, "uk")).toBe("У snoriq питання, 100 balloons чекає дозволу, funky rabbit ще працює, marshal готово.");
    expect(describeSessionStatus(sessions, "en")).toBe("Snoriq has a question, 100 balloons needs permission, funky rabbit is still working, marshal is done.");
  });

  it("folds many finished projects into the rest", () => {
    const sessions = [session("a", "busy"), session("b", "idle"), session("c", "idle"), session("d", "idle")];
    expect(describeSessionStatus(sessions, "uk")).toBe("A ще працює, решта готові.");
  });
});
