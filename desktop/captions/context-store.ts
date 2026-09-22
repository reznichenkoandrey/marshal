// desktop/captions/context-store.ts
//
// Reference files for the summarizer (V2 spec §2.4, "local context
// grounding"): a folder of Markdown / text files — CV, project README,
// stack notes — that goes into the system prompt so the bullets speak from
// the user's actual experience instead of a textbook.
//
// Deliberately a size-capped concatenation, not embeddings: a CV plus a
// project README fits in ~12k characters, and the whole block is a stable
// prompt prefix the Anthropic path can cache. Vector retrieval is a later
// step if people drop whole wikis in here.
//
// No Electron imports: the folder path comes from the caller, so this is
// testable with a temp dir.

import { promises as fs, type Stats } from "node:fs";
import path from "node:path";

export const CONTEXT_DIR_NAME = "captions-context";
export const DEFAULT_CONTEXT_MAX_CHARS = 12_000;
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text"]);

export interface ReferenceFile {
  name: string;
  chars: number;
  /** Characters actually included after the budget was applied. */
  included: number;
}

export interface ReferenceContext {
  /** The prompt block; empty when the folder is empty or missing. */
  text: string;
  files: ReferenceFile[];
  /** Characters dropped by the budget across all files. */
  truncated: number;
}

export const EMPTY_CONTEXT: ReferenceContext = { text: "", files: [], truncated: 0 };

interface Candidate {
  name: string;
  filePath: string;
  size: number;
  mtimeMs: number;
}

async function listCandidates(dir: string): Promise<Candidate[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const candidates: Candidate[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    const filePath = path.join(dir, name);
    let stat: Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    candidates.push({ name, filePath, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  // Smallest first: a budget overflow then cuts into the biggest file, not
  // into three small ones that would each have fit.
  candidates.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  return candidates;
}

/**
 * Reads every text file in `dir` into one block, each under a `### name`
 * header, within `maxChars`. When the budget runs out mid-file the file's
 * head is kept with a marker; later files are listed as omitted.
 */
export async function loadReferenceContext(
  dir: string,
  maxChars = DEFAULT_CONTEXT_MAX_CHARS
): Promise<ReferenceContext> {
  const candidates = await listCandidates(dir);
  if (candidates.length === 0) return EMPTY_CONTEXT;

  const blocks: string[] = [];
  const files: ReferenceFile[] = [];
  let remaining = maxChars;
  let truncated = 0;
  const omitted: string[] = [];

  for (const candidate of candidates) {
    const raw = (await fs.readFile(candidate.filePath, "utf8").catch(() => "")).trim();
    if (raw.length === 0) continue;
    const header = `### ${candidate.name}\n`;
    const room = remaining - header.length;
    if (room <= 200) {
      omitted.push(candidate.name);
      truncated += raw.length;
      files.push({ name: candidate.name, chars: raw.length, included: 0 });
      continue;
    }
    if (raw.length <= room) {
      blocks.push(header + raw);
      remaining -= header.length + raw.length;
      files.push({ name: candidate.name, chars: raw.length, included: raw.length });
    } else {
      const marker = "\n[… truncated]";
      const head = raw.slice(0, room - marker.length);
      blocks.push(header + head + marker);
      remaining = 0;
      truncated += raw.length - head.length;
      files.push({ name: candidate.name, chars: raw.length, included: head.length });
    }
  }
  if (omitted.length > 0) blocks.push(`(omitted for length: ${omitted.join(", ")})`);
  return { text: blocks.join("\n\n"), files, truncated };
}

/**
 * Re-reads the folder only when a file's size or mtime changed, or a file
 * appeared or vanished — the check is a readdir plus stats, cheap enough to
 * run before every summary so an edited CV applies without a restart.
 */
export class ReferenceContextCache {
  private readonly dir: string;
  private readonly maxChars: number;
  private signature = "";
  private context: ReferenceContext = EMPTY_CONTEXT;

  constructor(dir: string, maxChars = DEFAULT_CONTEXT_MAX_CHARS) {
    this.dir = dir;
    this.maxChars = maxChars;
  }

  get directory(): string {
    return this.dir;
  }

  async get(): Promise<ReferenceContext> {
    const candidates = await listCandidates(this.dir);
    const signature = candidates.map((c) => `${c.name}:${c.size}:${c.mtimeMs}`).join("|");
    if (signature !== this.signature) {
      this.context = await loadReferenceContext(this.dir, this.maxChars);
      this.signature = signature;
    }
    return this.context;
  }
}
