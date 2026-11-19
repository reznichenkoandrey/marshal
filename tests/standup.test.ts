import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectCommits, readTranscriptHead } from "../desktop/standup/collect.ts";
import { buildStandup, parseGitLog, renderStandup, topicFromTranscriptHead } from "../desktop/standup/standup.ts";

const NOW = new Date(2026, 10, 19, 15, 0, 0);
const TODAY = new Date(2026, 10, 19, 9, 0, 0).toISOString();
const YESTERDAY = new Date(2026, 10, 18, 22, 0, 0).toISOString();

describe("parseGitLog", () => {
  it("parses records with subjects that contain spaces and colons", () => {
    const stdout = `abcdef1234567890\x1f${TODAY}\x1ffeat: add reminders (#270)\x1e\n1234567890abcdef\x1f${YESTERDAY}\x1ffix: old\x1e`;
    const commits = parseGitLog(stdout, "marshal");
    expect(commits).toEqual([
      { hash: "abcdef12", subject: "feat: add reminders (#270)", repo: "marshal", at: TODAY },
      { hash: "12345678", subject: "fix: old", repo: "marshal", at: YESTERDAY }
    ]);
  });
});

describe("topicFromTranscriptHead", () => {
  it("takes the first real user prompt and skips sidechains and reminders", () => {
    const head = [
      JSON.stringify({ type: "user", isSidechain: true, message: { content: "sub-agent prompt" } }),
      JSON.stringify({ type: "user", message: { content: "<system-reminder>ctx</system-reminder>\nfix the tray menu" } })
    ].join("\n");
    expect(topicFromTranscriptHead(head)).toBe("fix the tray menu");
    expect(topicFromTranscriptHead("not json\n")).toBeNull();
  });
});

describe("buildStandup", () => {
  it("puts today's commits and calls in done, touched sessions in doing or blockers", () => {
    const card = buildStandup(
      {
        commits: [
          { hash: "abc12345", subject: "feat: x", repo: "marshal", at: TODAY },
          { hash: "old00000", subject: "fix: y", repo: "marshal", at: YESTERDAY }
        ],
        meetings: [{ title: "Sprint sync", startedAt: TODAY }],
        sessions: [
          { name: "marshal", status: "busy", project: "marshal", lastTopic: "meeting tasks", touchedAt: NOW.getTime() },
          { name: "snoriq", status: "waiting", project: "snoriq", lastTopic: "deploy?", touchedAt: NOW.getTime() },
          { name: "stale", status: "idle", project: "x", lastTopic: null, touchedAt: Date.parse(YESTERDAY) }
        ]
      },
      NOW,
      "en"
    );
    expect(card.done).toEqual(["marshal: feat: x (abc12345)", "Sprint sync"]);
    expect(card.doing).toEqual(["marshal (marshal): meeting tasks"]);
    expect(card.blockers).toEqual(["snoriq (snoriq): deploy?"]);
  });

  it("renders the Ukrainian headings and a dash for empty sections", () => {
    const text = renderStandup({ done: [], doing: ["a"], blockers: [] }, "uk");
    expect(text).toBe("Зроблено:\n- —\n\nВ роботі:\n- a\n\nБлокери:\n- —");
  });
});

describe("collectors on fixture repos", () => {
  let root: string;
  let repo: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "standup-"));
    repo = path.join(root, "proj");
    fs.mkdirSync(repo);
    const git = (...args: string[]): void => {
      execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    };
    git("init", "-q");
    git("-c", "user.name=Tester", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "feat: first thing");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("collects today's commits by author and skips folders that are not repos", async () => {
    const since = new Date(Date.now() - 60 * 60_000);
    const commits = await collectCommits([repo, path.join(root, "not-a-repo")], since, "Tester");
    expect(commits.map((c) => c.subject)).toEqual(["feat: first thing"]);
    expect(commits[0].repo).toBe("proj");
  });

  it("reads only the head of a transcript", async () => {
    const file = path.join(root, "session.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ type: "user", message: { content: "hello there" } })}\n`);
    expect(topicFromTranscriptHead(await readTranscriptHead(file))).toBe("hello there");
  });
});
