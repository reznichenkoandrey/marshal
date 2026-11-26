import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildActivity, buildRecall, findProject, listProjects, parsePrList, recallDays } from "../desktop/assistant/recall.ts";

let home: string;
let roots: string[];
let projectsDir: string;
let shotsDir: string;
const now = new Date(2026, 10, 26, 16, 0).getTime();

function write(file: string, text: string, mtime = now): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
}

function transcript(cwd: string, lines: object[]): string {
  return lines.map((line) => JSON.stringify({ cwd, gitBranch: "feat/x", ...line })).join("\n") + "\n";
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "recall-"));
  roots = [path.join(home, "htdocs")];
  projectsDir = path.join(home, "projects");
  shotsDir = path.join(home, "Screenshots");
  fs.mkdirSync(path.join(roots[0], "Snoriq", ".git"), { recursive: true });
  // A linked worktree next to the repo: `.git` is a file, so it is not a project.
  write(path.join(roots[0], "Snoriq-clock", ".git"), "gitdir: ../Snoriq/.git/worktrees/clock\n");
  fs.mkdirSync(path.join(home, "work", "secret", ".git"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("projects", () => {
  it("lists repos under the roots only, without linked worktrees", () => {
    expect(listProjects(roots).map((project) => project.name)).toEqual(["Snoriq"]);
  });

  it("finds a project by name in any case", () => {
    const projects = listProjects(roots);
    expect(findProject(projects, " snoriq ")?.folder).toBe(path.join(roots[0], "Snoriq"));
    expect(findProject(projects, "secret")).toBeNull();
  });

  it("keeps the day window sane", () => {
    expect(recallDays(3)).toBe(3);
    expect(recallDays(undefined)).toBe(7);
    expect(recallDays(0)).toBe(1);
    expect(recallDays(400)).toBe(30);
  });
});

describe("parsePrList", () => {
  it("reads gh JSON and ignores anything else", () => {
    expect(parsePrList('[{"number": 5, "title": "Fix", "state": "OPEN", "headRefName": "fix/a"}, {"title": "no number"}]'))
      .toEqual([{ number: 5, title: "Fix", state: "OPEN", branch: "fix/a" }]);
    expect(parsePrList("gh: not logged in")).toEqual([]);
  });
});

describe("buildRecall", () => {
  it("joins handoffs, sessions and open PRs of the window", () => {
    const repo = path.join(roots[0], "Snoriq");
    write(path.join(shotsDir, "Snoriq", "calls", "2026-11-23", "HANDOFF.md"),
      "# HANDOFF\n\n## Next\n- #439 NightNormalizer\n\n## Активні правила\n- identity rules\n\n## Traps\n- gates are slow\n");
    write(path.join(shotsDir, "Snoriq", "calls", "2026-11-10", "HANDOFF.md"), "# old\n- #100 ancient\n");
    const worktree = path.join(repo, ".claude", "worktrees", "night-439");
    write(path.join(projectsDir, worktree.replace(/[^A-Za-z0-9]/gu, "-"), "a.jsonl"), transcript(worktree, [
      { type: "user", message: { content: "<command-name>/clear</command-name>" } },
      { type: "user", message: { content: "зроби NightNormalizer #439" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Half done: parser wired, tests missing." }] } },
      { type: "custom-title", customTitle: "NightNormalizer" },
      { type: "pr-link", prNumber: 77 }
    ]), now - 3 * 24 * 60 * 60_000);
    write(path.join(projectsDir, path.join(home, "work", "secret").replace(/[^A-Za-z0-9]/gu, "-"), "b.jsonl"),
      transcript(path.join(home, "work", "secret"), [{ type: "user", message: { content: "secret work" } }]));

    const digest = buildRecall({
      project: { name: "Snoriq", folder: repo },
      days: 7,
      now,
      roots,
      prs: [{ number: 77, title: "NightNormalizer", state: "OPEN", branch: "feat/x" }, { number: 70, title: "Old", state: "MERGED", branch: "y" }],
      projectsDir,
      shotsDir
    });

    expect(digest).toContain("### 2026-11-23 HANDOFF.md");
    expect(digest).toContain("#439 NightNormalizer");
    expect(digest).toContain("gates are slow");
    expect(digest).not.toContain("identity rules");
    expect(digest).not.toContain("#100 ancient");
    expect(digest).toContain('"NightNormalizer" · branch feat/x · worktree night-439 · PR #77 (open)');
    expect(digest).toContain("first ask: зроби NightNormalizer #439");
    expect(digest).toContain("last answer: Half done: parser wired, tests missing.");
    expect(digest).toContain("- #77 NightNormalizer (feat/x)");
    expect(digest).not.toContain("#70 Old");
    expect(digest).not.toContain("secret work");
  });

  it("reads sessions of a linked worktree next to the repo", () => {
    const repo = path.join(roots[0], "Snoriq");
    const sibling = path.join(roots[0], "Snoriq-clock");
    write(path.join(repo, ".git", "worktrees", "clock", "gitdir"), `${path.join(sibling, ".git")}\n`);
    write(path.join(projectsDir, sibling.replace(/[^A-Za-z0-9]/gu, "-"), "d.jsonl"),
      transcript(sibling, [{ type: "user", message: { content: "доробити годинник пристрою" } }]));
    const digest = buildRecall({ project: { name: "Snoriq", folder: repo }, days: 3, now, roots, prs: [], projectsDir, shotsDir });
    expect(digest).toContain("worktree Snoriq-clock");
    expect(digest).toContain("first ask: доробити годинник пристрою");
  });

  it("lists recent sessions of every project when none is named", () => {
    const repo = path.join(roots[0], "Snoriq");
    const marshal = path.join(roots[0], "marshal");
    fs.mkdirSync(path.join(marshal, ".git"), { recursive: true });
    write(path.join(projectsDir, repo.replace(/[^A-Za-z0-9]/gu, "-"), "e.jsonl"),
      transcript(repo, [{ type: "user", message: { content: "зроби NightNormalizer" } }, { type: "custom-title", customTitle: "NightNormalizer" }]), now - 3 * 24 * 60 * 60_000);
    write(path.join(projectsDir, marshal.replace(/[^A-Za-z0-9]/gu, "-"), "f.jsonl"), transcript(marshal, [{ type: "user", message: { content: "recall worktrees" } }]));
    write(path.join(projectsDir, path.join(home, "work", "secret").replace(/[^A-Za-z0-9]/gu, "-"), "g.jsonl"),
      transcript(path.join(home, "work", "secret"), [{ type: "user", message: { content: "secret work" } }]));
    const activity = buildActivity({ projects: listProjects(roots), days: 7, now, roots, projectsDir });
    expect(activity.indexOf("marshal · (untitled)")).toBeLessThan(activity.indexOf('Snoriq · "NightNormalizer"'));
    expect(activity).toContain("first ask: зроби NightNormalizer");
    expect(activity).not.toContain("secret work");
  });

  it("says when there is nothing and when PRs are unknown", () => {
    const digest = buildRecall({ project: { name: "Snoriq", folder: path.join(roots[0], "Snoriq") }, days: 3, now, roots, prs: null, projectsDir, shotsDir });
    expect(digest).toContain("Handoff notes (newest first):\n- none");
    expect(digest).toContain("Sessions (newest first):\n- none");
    expect(digest).toContain("- unknown (could not read them)");
  });

  it("does not read a session whose folder is outside the roots (#303)", () => {
    const repo = path.join(roots[0], "Snoriq");
    write(path.join(projectsDir, repo.replace(/[^A-Za-z0-9]/gu, "-"), "c.jsonl"), transcript(repo, [{ type: "user", message: { content: "allowed" } }]));
    const digest = buildRecall({ project: { name: "Snoriq", folder: repo }, days: 3, now, roots: [path.join(home, "other")], prs: [], projectsDir, shotsDir });
    expect(digest).not.toContain("allowed");
  });
});
