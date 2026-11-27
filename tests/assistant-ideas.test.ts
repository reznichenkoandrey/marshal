import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendIdea, ideaBrief, matchIdeaCommand, resolveIdeasDir } from "../desktop/assistant/ideas.ts";
import { matchLocalCommand } from "../desktop/assistant/local-command.ts";

describe("matchIdeaCommand", () => {
  it.each([
    ["Ідея: застосунок для обліку ліків", "застосунок для обліку ліків"],
    ["Маршал, ідея, таймер для дітей", "таймер для дітей"],
    ["маршале нова ідея трекер звичок", "трекер звичок"],
    ["Запиши ідею — казка голосом мами", "казка голосом мами"],
    ["Запиши: метроном з тюнером", "метроном з тюнером"],
    ["Hey Marshal, new idea: a habit tracker", "a habit tracker"],
    ["note: offline tale reader", "offline tale reader"],
    ["Ідея.", ""],
    ["запиши", ""]
  ])("%s", (said, idea) => {
    expect(matchIdeaCommand(said)).toEqual({ idea });
  });

  it.each(["ідеальний план на завтра", "що там по сесіях", "записи дзвінків", "відкрий перекладач", "screenshot", "notebook", "текст\nідея"])(
    "not an idea: %s",
    (said) => {
      expect(matchIdeaCommand(said)).toBeNull();
    }
  );

  it("leaves record commands to local commands, which run first", () => {
    expect(matchLocalCommand("запиши дзвінок")).toEqual({ kind: "action", action: "record-call" });
    expect(matchLocalCommand("запиши екран")).toEqual({ kind: "action", action: "record-screen" });
  });
});

describe("resolveIdeasDir", () => {
  it("expands home and treats empty as off", () => {
    expect(resolveIdeasDir("  ", "/Users/me")).toBeNull();
    expect(resolveIdeasDir("~/htdocs/apps", "/Users/me")).toBe("/Users/me/htdocs/apps");
    expect(resolveIdeasDir("/srv/ideas", "/Users/me")).toBe("/srv/ideas");
  });
});

describe("appendIdea", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("creates INBOX.md with a header once and appends dated entries", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "marshal-ideas-"));
    await appendIdea(dir, "перша ідея", new Date(2026, 10, 27, 9, 5), "uk");
    const heading = await appendIdea(dir, "# друга ідея", new Date(2026, 10, 27, 21, 50), "uk");
    expect(heading).toBe("2026-11-27 21:50");
    const inbox = await readFile(path.join(dir, "INBOX.md"), "utf8");
    expect(inbox.match(/^# Inbox ідей/gmu)).toHaveLength(1);
    expect(inbox).toContain("## 2026-11-27 09:05\n\nперша ідея\n");
    expect(inbox).toContain("## 2026-11-27 21:50\n\nдруга ідея\n");
  });

  it("refuses a folder that does not exist", async () => {
    await expect(appendIdea("/nonexistent/marshal-ideas", "x", new Date(), "en")).rejects.toThrow();
  });
});

describe("ideaBrief", () => {
  it("quotes the idea, points at the inbox entry and forbids publishing", () => {
    const brief = ideaBrief("трекер звичок", "2026-11-27 21:50", "uk");
    expect(brief).toContain("«трекер звичок»");
    expect(brief).toContain("## 2026-11-27 21:50");
    expect(brief).toContain("go / no-go");
    expect(brief).toContain("не пуш");
    expect(ideaBrief("habit tracker", "2026-11-27 21:50", "en")).toContain("Do not push");
  });
});
