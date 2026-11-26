// "What did we leave unfinished in Snoriq?" (#530): one plain-text digest of a
// project's recent work for the voice agent, built without a model. Sources
// are what the owner's tooling already leaves on disk: handoff notes
// (`~/Screenshots/<project>/calls/<date>/HANDOFF*.md`), Claude Code
// transcripts of the repo and its worktrees, and the repo's pull requests.
// Only projects under `claudeCodeRoutingRoots` are read (#303).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseTranscriptTail, readTail } from "../claude-code/dossier.ts";
import { isUnderRoots } from "../claude-code/context-router.ts";

export type RecallProject = { name: string; folder: string };
export type RecallPr = { number: number; title: string; state: string; branch: string };

const DAY_MS = 24 * 60 * 60_000;
export const DEFAULT_RECALL_DAYS = 7;
export const MAX_RECALL_DAYS = 30;
const MAX_SESSIONS = 12;
const HEAD_BYTES = 256 * 1024;
const HANDOFF_CHARS = 2_500;
const HANDOFFS_CHARS = 9_000;
const FIELD_CHARS = 300;
const DIGEST_CHARS = 20_000;
// Sections the SessionEnd hook adds to every handoff: rules and other projects, not this project's work.
const NOISE_SECTIONS = /^##\s+(Активні правила|Recent cross-project activity)/u;

/**
 * Git repos the owner allowed: a root that is a repo, or the repos right inside a root.
 * A linked worktree (`.git` is a file) is part of its repo, not a project of its own.
 */
export function listProjects(roots: readonly string[]): RecallProject[] {
  const projects = new Map<string, RecallProject>();
  const add = (folder: string) => {
    try {
      if (!fs.statSync(path.join(folder, ".git")).isDirectory()) return;
    } catch {
      return;
    }
    const name = path.basename(folder);
    if (!projects.has(name.toLowerCase())) projects.set(name.toLowerCase(), { name, folder });
  };
  for (const root of roots) {
    add(root);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".")) add(path.join(root, entry.name));
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The project by its exact name, any case; the model picks from the list it was shown. */
export function findProject(projects: readonly RecallProject[], name: string): RecallProject | null {
  const wanted = name.trim().toLowerCase();
  return projects.find((project) => project.name.toLowerCase() === wanted) ?? null;
}

export function recallDays(value: unknown): number {
  const days = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_RECALL_DAYS;
  return Math.min(MAX_RECALL_DAYS, Math.max(1, days));
}

/** `gh pr list --json number,title,state,headRefName` output; anything else is no PRs. */
export function parsePrList(json: string): RecallPr[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const pr = item as Record<string, unknown>;
    if (typeof pr.number !== "number" || typeof pr.title !== "string") return [];
    return [{ number: pr.number, title: pr.title, state: String(pr.state ?? ""), branch: String(pr.headRefName ?? "") }];
  });
}

function localDay(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function clock(time: number): string {
  const date = new Date(time);
  return `${localDay(time)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function withoutNoise(markdown: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) skipping = NOISE_SECTIONS.test(line);
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Handoff notes of the project since `sinceDay`, newest first. */
export function readHandoffs(shotsDir: string, project: string, sinceDay: string): { day: string; file: string; text: string }[] {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(shotsDir).filter((dir) => dir.toLowerCase() === project.toLowerCase());
  } catch {
    return [];
  }
  const notes: { day: string; file: string; text: string }[] = [];
  for (const dir of dirs) {
    const calls = path.join(shotsDir, dir, "calls");
    let days: string[] = [];
    try {
      days = fs.readdirSync(calls).filter((day) => /^\d{4}-\d{2}-\d{2}$/u.test(day) && day >= sinceDay);
    } catch {
      continue;
    }
    for (const day of days) {
      let files: string[] = [];
      try {
        files = fs.readdirSync(path.join(calls, day)).filter((file) => /^HANDOFF.*\.md$/u.test(file));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          notes.push({ day, file, text: withoutNoise(fs.readFileSync(path.join(calls, day, file), "utf8")) });
        } catch {
          // An unreadable note is skipped; the rest still help.
        }
      }
    }
  }
  return notes.sort((a, b) => b.day.localeCompare(a.day) || a.file.localeCompare(b.file));
}

export type RecallSession = {
  at: number;
  title: string | null;
  cwd: string;
  branch: string | null;
  firstAsk: string | null;
  lastAsk: string | null;
  lastAnswer: string | null;
  prs: number[];
};

function lines(text: string): Record<string, unknown>[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function readHead(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    return read === HEAD_BYTES ? text.slice(0, text.lastIndexOf("\n")) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function userText(o: Record<string, unknown>): string | null {
  if (o.type !== "user" || o.isSidechain === true || o.isMeta === true) return null;
  const content = (o.message as { content?: unknown } | undefined)?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block: unknown) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "")).join("\n")
      : "";
  const trimmed = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, "").trim();
  // Harness blocks (`<command-name>`, hook output) are not the owner's words.
  return trimmed && !trimmed.startsWith("<") ? trimmed : null;
}

/** One transcript as a few facts; null when it is not this project's or not allowed (#303). */
export function readSession(file: string, mtimeMs: number, folders: readonly string[], roots: readonly string[]): RecallSession | null {
  const head = lines(readHead(file));
  const cwd = head.find((o) => typeof o.cwd === "string")?.cwd;
  if (typeof cwd !== "string" || !isUnderRoots(cwd, roots) || !isUnderRoots(cwd, folders)) return null;
  const { text, partial } = readTail(file);
  const tail = lines(partial ? text.slice(text.indexOf("\n") + 1) : text);
  const all = [...head, ...tail];
  let title: string | null = null;
  let lastAsk: string | null = null;
  const prs = new Set<number>();
  for (const o of all) {
    if (o.type === "custom-title" && typeof o.customTitle === "string") title = o.customTitle;
    if (!title && o.type === "agent-name" && typeof o.agentName === "string") title = o.agentName;
    if (o.type === "last-prompt" && typeof o.lastPrompt === "string" && !o.lastPrompt.trim().startsWith("<")) lastAsk = o.lastPrompt;
    if (o.type === "pr-link" && typeof o.prNumber === "number") prs.add(o.prNumber);
  }
  const firstAsk = head.map(userText).find((ask) => ask !== null) ?? null;
  const turns = parseTranscriptTail(text, partial);
  lastAsk ??= [...turns.turns].reverse().find((turn) => turn.role === "user")?.text ?? null;
  const lastAnswer = [...turns.turns].reverse().find((turn) => turn.role === "assistant")?.text ?? null;
  return { at: mtimeMs, title, cwd, branch: turns.branch, firstAsk, lastAsk, lastAnswer, prs: [...prs] };
}

/** The repo plus its linked worktrees anywhere on disk (`git worktree add ../Repo-x`), read from `.git/worktrees/*\/gitdir`. */
export function projectFolders(folder: string): string[] {
  const folders = [folder];
  const meta = path.join(folder, ".git", "worktrees");
  let names: string[] = [];
  try {
    names = fs.readdirSync(meta);
  } catch {
    return folders;
  }
  for (const name of names) {
    try {
      const gitFile = fs.readFileSync(path.join(meta, name, "gitdir"), "utf8").trim();
      if (path.isAbsolute(gitFile)) folders.push(path.dirname(gitFile));
    } catch {
      // A pruned worktree leaves no gitdir file.
    }
  }
  return folders;
}

/** Transcript folders of the repo and of its worktrees, by Claude Code's cwd encoding. */
function transcriptDirs(projectsDir: string, folders: readonly string[]): string[] {
  const encoded = folders.map((folder) => folder.replace(/[^A-Za-z0-9]/gu, "-"));
  try {
    return fs.readdirSync(projectsDir)
      .filter((dir) => encoded.some((base) => dir === base || dir.startsWith(`${base}--claude-worktrees-`)))
      .map((dir) => path.join(projectsDir, dir));
  } catch {
    return [];
  }
}

export function readSessions(projectsDir: string, folder: string, roots: readonly string[], since: number): RecallSession[] {
  const files: { file: string; mtimeMs: number }[] = [];
  const folders = projectFolders(folder);
  for (const dir of transcriptDirs(projectsDir, folders)) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const { mtimeMs } = fs.statSync(path.join(dir, name));
        if (mtimeMs >= since) files.push({ file: path.join(dir, name), mtimeMs });
      } catch {
        // Gone between readdir and stat.
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, MAX_SESSIONS).flatMap(({ file, mtimeMs }) => {
    try {
      return readSession(file, mtimeMs, folders, roots) ?? [];
    } catch {
      return [];
    }
  });
}

export type RecallOptions = {
  project: RecallProject;
  days: number;
  now: number;
  roots: readonly string[];
  /** null = the PR list could not be read (no `gh`, offline). */
  prs: readonly RecallPr[] | null;
  projectsDir?: string;
  shotsDir?: string;
};

export function defaultShotsDir(): string {
  return process.env.CLAUDE_SHOTS_DIR || path.join(os.homedir(), "Screenshots");
}

/** The digest the agent reads: handoffs, sessions, open PRs. Plain text, capped. */
export function buildRecall(options: RecallOptions): string {
  const { project, days, now, roots, prs } = options;
  const since = now - days * DAY_MS;
  const sinceDay = localDay(since);
  const out = [`Project ${project.name}, last ${days} days (since ${sinceDay}).`];

  out.push("", "Handoff notes (newest first):");
  let budget = HANDOFFS_CHARS;
  const notes = readHandoffs(options.shotsDir ?? defaultShotsDir(), project.name, sinceDay);
  if (notes.length === 0) out.push("- none");
  for (const note of notes) {
    if (budget <= 0) break;
    const text = note.text.slice(0, Math.min(HANDOFF_CHARS, budget));
    budget -= text.length;
    out.push(`### ${note.day} ${note.file}`, text);
  }

  const prState = new Map((prs ?? []).map((pr) => [pr.number, pr.state.toLowerCase()]));
  out.push("", "Sessions (newest first):");
  const sessions = readSessions(options.projectsDir ?? path.join(os.homedir(), ".claude", "projects"), project.folder, roots, since);
  if (sessions.length === 0) out.push("- none");
  for (const session of sessions) {
    const worktree = session.cwd === project.folder ? null : path.basename(session.cwd);
    const prsText = session.prs.map((n) => `PR #${n}${prState.has(n) ? ` (${prState.get(n)})` : ""}`).join(", ");
    const meta = [session.branch && `branch ${session.branch}`, worktree && `worktree ${worktree}`, prsText || "no PR"].filter(Boolean).join(" · ");
    out.push(`- ${clock(session.at)} ${session.title ? JSON.stringify(session.title) : "(untitled)"} · ${meta}`);
    if (session.firstAsk) out.push(`  first ask: ${cut(session.firstAsk, FIELD_CHARS)}`);
    if (session.lastAsk && session.lastAsk !== session.firstAsk) out.push(`  last ask: ${cut(session.lastAsk, FIELD_CHARS)}`);
    if (session.lastAnswer) out.push(`  last answer: ${cut(session.lastAnswer, FIELD_CHARS)}`);
  }

  out.push("", "Open pull requests:");
  if (prs === null) out.push("- unknown (could not read them)");
  else {
    const open = prs.filter((pr) => pr.state.toUpperCase() === "OPEN");
    if (open.length === 0) out.push("- none");
    for (const pr of open) out.push(`- #${pr.number} ${cut(pr.title, 120)} (${pr.branch})`);
  }
  const digest = out.join("\n");
  return digest.length > DIGEST_CHARS ? `${digest.slice(0, DIGEST_CHARS)}\n…(cut)` : digest;
}
