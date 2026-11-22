import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clusterLines,
  collectLines,
  findCandidates,
  jaccard,
  normalizePrompt,
  promptFromLine,
  scanDue,
  tokenize,
  verifyProposal,
  type Prompt
} from "../desktop/automation-ideas/detect.ts";
import { AutomationIdeas, readIdeasStore, scanTranscripts, writeIdeasStore } from "../desktop/automation-ideas/scan.ts";

const ROOTS = ["/Users/me/htdocs"];
const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60_000;
const SINCE = NOW - 7 * DAY;

// Line shape copied from a real Claude Code 2.1.317 transcript, trimmed.
function userLine(text: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: text },
    timestamp: new Date(NOW - DAY).toISOString(),
    cwd: "/Users/me/htdocs/marshal",
    sessionId: "a",
    gitBranch: "main",
    ...overrides
  });
}

const prompt = (text: string, day: string, project = "marshal"): Prompt => ({ text, day, project });

describe("normalizePrompt", () => {
  it("drops what differs between two sayings of the same request", () => {
    expect(normalizePrompt("  Прожени   тести\nв Marshal ")).toBe("прожени тести в marshal");
    expect(normalizePrompt("fix #123 and #45")).toBe("fix #N and #N");
    expect(normalizePrompt("retry 3 times, session 552fce48-fa27-4cdc-b196-2e6f84e1bcad")).toBe("retry times, session");
    expect(normalizePrompt("read /private/tmp/claude-501/x/out.log please")).toBe("read please");
    expect(normalizePrompt("run tests <system-reminder>secret</system-reminder>")).toBe("run tests");
  });
});

describe("promptFromLine", () => {
  it("takes the owner's text from a session under the allowed folders", () => {
    expect(promptFromLine(userLine("Прожени тести в marshal"), ROOTS, SINCE, NOW)).toEqual({
      text: "прожени тести в marshal",
      day: "2026-11-19",
      project: "marshal"
    });
    const blocks = [{ type: "text", text: "run the tests in marshal" }];
    expect(promptFromLine(userLine(blocks), ROOTS, SINCE, NOW)?.text).toBe("run the tests in marshal");
  });

  it("counts a worktree session under its repository", () => {
    const line = userLine("run the tests please", { cwd: "/Users/me/htdocs/marshal/.claude/worktrees/x-1" });
    expect(promptFromLine(line, ROOTS, SINCE, NOW)?.project).toBe("marshal");
  });

  it("never reads a session outside the allowed folders (#303)", () => {
    expect(promptFromLine(userLine("run the tests in the shop", { cwd: "/Users/me/work/shop" }), ROOTS, SINCE, NOW)).toBeNull();
    expect(promptFromLine(userLine("run the tests in the shop", { cwd: "/Users/me/htdocs-other" }), ROOTS, SINCE, NOW)).toBeNull();
    expect(promptFromLine(userLine("run the tests in marshal"), [], SINCE, NOW)).toBeNull();
    expect(promptFromLine(userLine("run the tests in marshal", { cwd: undefined }), ROOTS, SINCE, NOW)).toBeNull();
  });

  it("skips everything that is not a request", () => {
    const skipped = [
      userLine("run the tests in marshal", { type: "assistant" }),
      userLine("run the tests in marshal", { isSidechain: true }),
      userLine("run the tests in marshal", { isMeta: true }),
      userLine("run the tests in marshal", { timestamp: new Date(NOW - 8 * DAY).toISOString() }),
      userLine("run the tests in marshal", { timestamp: undefined }),
      userLine("так, давай"),
      userLine("x".repeat(401)),
      userLine("<command-name>/model</command-name> and more text"),
      userLine([{ type: "tool_result", tool_use_id: "t", content: "run the tests in marshal" }]),
      "not json with \"user\" in it",
      JSON.stringify({ type: "queue-operation" })
    ];
    for (const line of skipped) expect(promptFromLine(line, ROOTS, SINCE, NOW)).toBeNull();
  });
});

describe("clustering", () => {
  it("ignores stop-words and measures token overlap", () => {
    expect([...tokenize("прожени тести в marshal і fix #N")]).toEqual(["прожени", "тести", "marshal", "fix", "#N"]);
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(0.5);
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0);
  });

  it("groups different phrasings, keeps languages apart", () => {
    const lines = collectLines([
      prompt("прожени всі тести в marshal", "2026-11-17"),
      prompt("прожени тести в marshal", "2026-11-18"),
      prompt("прожени тести в marshal", "2026-11-19"),
      prompt("run the tests in marshal", "2026-11-19"),
      prompt("зроби коміт і pr", "2026-11-19")
    ]);
    expect(lines.map((line) => [line.id, line.count])).toEqual([["L1", 1], ["L2", 2], ["L3", 1], ["L4", 1]]);
    expect(clusterLines(lines).map((cluster) => cluster.map((line) => line.id))).toEqual([["L1", "L2"], ["L3"], ["L4"]]);
  });
});

describe("findCandidates", () => {
  it("needs 3 repeats on 2 days, or 5 in one project", () => {
    const candidates = findCandidates(collectLines([
      prompt("прожени всі тести в marshal", "2026-11-17"),
      prompt("прожени тести в marshal", "2026-11-18"),
      prompt("прожени тести в marshal", "2026-11-18"),
      // Three times, but on one day.
      prompt("зроби коміт і pr", "2026-11-19"),
      prompt("зроби коміт і pr", "2026-11-19"),
      prompt("зроби коміт і pr", "2026-11-19"),
      // Five times on one day in one project.
      ...Array.from({ length: 5 }, () => prompt("check the ci run", "2026-11-19", "snoriq")),
      // Five times on one day, spread over projects.
      ...["a", "b", "c", "d", "e"].map((project) => prompt("update the changelog file", "2026-11-19", project))
    ]));
    expect(candidates).toEqual([
      { id: "C1", representative: "check the ci run", ids: ["L4"], count: 5, days: ["2026-11-19"], projects: { snoriq: 5 } },
      {
        id: "C2",
        representative: "прожени всі тести в marshal",
        ids: ["L1", "L2"],
        count: 3,
        days: ["2026-11-17", "2026-11-18"],
        projects: { marshal: 3 }
      }
    ]);
  });
});

describe("verifyProposal", () => {
  const lines = collectLines([
    prompt("прожени всі тести в marshal", "2026-11-17"),
    prompt("прожени тести в marshal", "2026-11-18"),
    prompt("прожени тести в marshal", "2026-11-18"),
    prompt("зроби коміт і pr", "2026-11-19")
  ]);

  it("accepts only what the local counts confirm", () => {
    expect(verifyProposal({ name: "run-tests", ids: ["L1", "L2"] }, lines, ["deploy"])).toBe(true);
    // An id the model invented.
    expect(verifyProposal({ name: "run-tests", ids: ["L1", "L9"] }, lines, [])).toBe(false);
    // Real ids that do not add up: 2 repeats on one day, and citing one twice does not help.
    expect(verifyProposal({ name: "run-tests", ids: ["L2", "L2"] }, lines, [])).toBe(false);
    expect(verifyProposal({ name: "commit-pr", ids: ["L3"] }, lines, [])).toBe(false);
    expect(verifyProposal({ name: "run-tests", ids: [] }, lines, [])).toBe(false);
  });

  it("never proposes a skill that already exists", () => {
    expect(verifyProposal({ name: "Run-Tests", ids: ["L1", "L2"] }, lines, ["run-tests"])).toBe(false);
    expect(verifyProposal({ name: " ", ids: ["L1", "L2"] }, lines, [])).toBe(false);
  });
});

describe("scanDue", () => {
  const monday = new Date(2026, 10, 16, 0, 0, 0).getTime();

  it("is due once per week, from Monday", () => {
    expect(scanDue(null, NOW)).toBe(true);
    expect(scanDue(monday - 1, NOW)).toBe(true);
    expect(scanDue(monday, NOW)).toBe(false);
    expect(scanDue(monday + DAY, new Date(2026, 10, 22, 23, 59).getTime())).toBe(false);
    expect(scanDue(monday + DAY, new Date(2026, 10, 23, 0, 1).getTime())).toBe(true);
  });
});

describe("scanTranscripts", () => {
  let dir = "";

  function transcript(folder: string, name: string, lines: string[], mtime = NOW): string {
    const file = path.join(dir, "projects", folder, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
    return file;
  }

  function setup(): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-ideas-"));
    const at = (days: number) => ({ timestamp: new Date(NOW - days * DAY).toISOString() });
    transcript("-Users-me-htdocs-marshal", "a.jsonl", [
      JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: "a" }),
      userLine("Прожени тести в marshal", at(1)),
      userLine("прожени всі тести в marshal", at(2)),
      userLine("one-off question about the build", at(2))
    ]);
    transcript("-Users-me-htdocs-marshal", "b.jsonl", [userLine("прожени тести в marshal", at(3))]);
    // Another workspace repeats the same words; it must not add to any counter.
    const work = { cwd: "/Users/me/work/shop" };
    transcript("-Users-me-work-shop", "c.jsonl", Array.from({ length: 6 }, () => userLine("прожени тести в marshal", { ...at(1), ...work })));
    // Not touched inside the window: never opened.
    transcript("-Users-me-htdocs-old", "d.jsonl", [userLine("прожени тести в marshal", at(1))], NOW - 8 * DAY);
    return path.join(dir, "projects");
  }

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = "";
    vi.restoreAllMocks();
  });

  it("finds repeats in the allowed folders only and keeps only cited lines", async () => {
    const result = await scanTranscripts({ roots: ROOTS, projectsDir: setup(), now: NOW });
    expect(result).toMatchObject({ partial: false, files: 3, prompts: 4 });
    expect(result.candidates).toEqual([
      {
        id: "C1",
        representative: "прожени всі тести в marshal",
        ids: ["L1", "L2"],
        count: 3,
        days: ["2026-11-17", "2026-11-18", "2026-11-19"],
        projects: { marshal: 3 }
      }
    ]);
    expect(result.lines.map((line) => line.text)).toEqual(["прожени тести в marshal", "прожени всі тести в marshal"]);
  });

  it("opens nothing without allowed folders", async () => {
    const projectsDir = setup();
    const read = vi.spyOn(fs, "createReadStream");
    const list = vi.spyOn(fs, "readdirSync");
    expect(await scanTranscripts({ roots: [], projectsDir, now: NOW })).toMatchObject({ files: 0, prompts: 0, candidates: [] });
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("stops at the file limit and says the result is partial", async () => {
    const result = await scanTranscripts({ roots: ROOTS, projectsDir: setup(), now: NOW, maxFiles: 1 });
    expect(result).toMatchObject({ partial: true, files: 1 });
  });

  it("keeps the owner's earlier decisions across scans", async () => {
    const projectsDir = setup();
    const storePath = path.join(dir, "automation-ideas.json");
    fs.writeFileSync(storePath, JSON.stringify({ scannedAt: 1, candidates: [], rejected: ["run-tests"], created: ["commit-pr"] }));
    writeIdeasStore(storePath, await scanTranscripts({ roots: ROOTS, projectsDir, now: NOW }));
    const store = readIdeasStore(storePath);
    expect(store).toMatchObject({ scannedAt: NOW, rejected: ["run-tests"], created: ["commit-pr"] });
    expect(store?.candidates).toHaveLength(1);
    expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
  });

  it("scans on a Stop hook once a week, and only when switched on", async () => {
    const projectsDir = setup();
    const storePath = path.join(dir, "automation-ideas.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
    let enabled = false;
    let now = NOW;
    const ideas = new AutomationIdeas({ storePath, enabled: () => enabled, roots: () => ROOTS, projectsDir, now: () => now });

    ideas.onSessionStop();
    expect(await ideas.scan()).toBeNull();
    expect(fs.existsSync(storePath)).toBe(false);

    enabled = true;
    ideas.onSessionStop();
    await ideas.scan();
    expect(readIdeasStore(storePath)?.scannedAt).toBe(NOW);

    // Later the same week: the Stop hook does not scan again.
    now = NOW + DAY;
    ideas.onSessionStop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readIdeasStore(storePath)?.scannedAt).toBe(NOW);

    // Next Monday it does.
    now = new Date(2026, 10, 23, 9, 0).getTime();
    ideas.onSessionStop();
    await ideas.scan();
    expect(readIdeasStore(storePath)?.scannedAt).toBe(now);
  });
});
