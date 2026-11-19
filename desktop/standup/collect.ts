// Readers for the standup card: git commits by the owner across project
// folders, and the head of Claude Code transcripts touched today. Local only.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { GIT_LOG_FORMAT, parseGitLog, topicFromTranscriptHead, type CommitFact, type SessionFact } from "./standup.ts";

const execFileAsync = promisify(execFile);
const TRANSCRIPT_HEAD_BYTES = 64 * 1024;

/** Commits by `author` since local midnight in each root; a root that is not a repo is skipped. */
export async function collectCommits(roots: readonly string[], since: Date, author: string): Promise<CommitFact[]> {
  const commits: CommitFact[] = [];
  for (const root of roots) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", root, "log", `--since=${since.toISOString()}`, `--author=${author}`, `--pretty=format:${GIT_LOG_FORMAT}`],
        { maxBuffer: 4 * 1024 * 1024 }
      );
      commits.push(...parseGitLog(stdout, path.basename(root)));
    } catch {
      // Not a repository, or git is missing: that folder contributes nothing.
    }
  }
  return commits;
}

/** Reads only the head of a transcript; the first user prompt is enough for the card. */
export async function readTranscriptHead(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TRANSCRIPT_HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Session facts for transcripts modified since `since`; `projectOf` maps a transcript to its project name. */
export async function collectSessions(
  transcripts: readonly { file: string; name: string; status: string | null; project: string }[],
  since: Date
): Promise<SessionFact[]> {
  const facts: SessionFact[] = [];
  for (const entry of transcripts) {
    try {
      const stat = await fs.stat(entry.file);
      if (stat.mtimeMs < since.getTime()) continue;
      facts.push({
        name: entry.name,
        status: entry.status,
        project: entry.project,
        lastTopic: topicFromTranscriptHead(await readTranscriptHead(entry.file)),
        touchedAt: stat.mtimeMs
      });
    } catch {
      // Transcript vanished or is unreadable: skip it, the card is best effort.
    }
  }
  return facts;
}

/** Every transcript under ~/.claude/projects/<folder>/<sessionId>.jsonl, named by its live session when there is one. */
export async function listTranscripts(
  projectsDir: string,
  live: readonly { sessionId: string; name: string; status: string | null; cwd: string }[]
): Promise<{ file: string; name: string; status: string | null; project: string }[]> {
  const byId = new Map(live.map((session) => [session.sessionId, session]));
  const out: { file: string; name: string; status: string | null; project: string }[] = [];
  let folders: string[];
  try {
    folders = await fs.readdir(projectsDir);
  } catch {
    return out;
  }
  for (const folder of folders) {
    let files: string[];
    try {
      files = await fs.readdir(path.join(projectsDir, folder));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.slice(0, -".jsonl".length);
      const session = byId.get(sessionId);
      out.push({
        file: path.join(projectsDir, folder, file),
        name: session?.name ?? sessionId.slice(0, 8),
        status: session?.status ?? null,
        project: session ? path.basename(session.cwd) : folder.split("-").filter(Boolean).at(-1) ?? folder
      });
    }
  }
  return out;
}
