// Stage A of #273: read the last week of the owner's prompts from Claude Code
// transcripts in the allowed folders (#303), find the repeated ones and keep
// the candidates in <userData>/automation-ideas.json. No model, no UI, no
// timer (#281): the scan runs on the first Stop hook of a week, or on demand.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { isUnderRoots } from "../claude-code/context-router.ts";
import { defaultProjectsDir } from "../claude-code/dossier.ts";
import { collectLines, findCandidates, promptFromLine, scanDue, WINDOW_MS, type Candidate, type Line, type Prompt } from "./detect.ts";
import {
  acceptProposals,
  buildProposalRequest,
  createSkill,
  defaultSkillsDir,
  isDecided,
  listSkills,
  parseProposals,
  withoutDecided,
  type CreateResult,
  type Decided,
  type Proposal
} from "./propose.ts";

const MAX_FILES = 2000;
const MAX_SCAN_MS = 10 * 60_000;

export type ScanResult = {
  scannedAt: number;
  /** The file or time limit cut the scan short: the candidates are what was found so far. */
  partial: boolean;
  files: number;
  prompts: number;
  /** Only the lines the candidates cite; one-off prompts are not kept outside the transcripts. */
  lines: Line[];
  candidates: Candidate[];
};

/** Stage B: checked proposals waiting for the owner, ideas they declined and skills already created. */
export type IdeasStore = ScanResult & { proposals: Proposal[]; rejected: Decided[]; created: Decided[] };

/** A proposal as the owner sees it: the evidence is the cited phrasings, shown on this Mac only. */
export type IdeaView = Pick<Proposal, "id" | "name" | "description" | "steps" | "count" | "days"> & { evidence: string[] };

export type ScanOptions = {
  roots: readonly string[];
  projectsDir?: string;
  now?: number;
  maxFiles?: number;
  maxMs?: number;
};

/** Transcripts touched inside the window, newest first; subagent folders are not listed. */
function recentTranscripts(projectsDir: string, since: number): string[] {
  const found: { file: string; mtimeMs: number }[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return [];
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(projectsDir, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(projectsDir, dir, name);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (mtimeMs >= since) found.push({ file, mtimeMs });
      } catch {
        // Gone between readdir and stat.
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.file);
}

const CWD_FIELD = /"cwd":"((?:[^"\\]|\\.)*)"/u;

/**
 * One transcript, line by line: these files reach hundreds of MB. A file whose
 * first `cwd` is outside the allowed folders is closed right there, so a
 * session of another workspace is never read past that line (#303).
 */
async function readPrompts(file: string, roots: readonly string[], since: number, now: number, deadline: number): Promise<Prompt[]> {
  const prompts: Prompt[] = [];
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let placed = false;
  try {
    for await (const raw of reader) {
      if (Date.now() > deadline) break;
      if (!placed) {
        const match = CWD_FIELD.exec(raw);
        if (!match) continue;
        let cwd: unknown;
        try {
          cwd = JSON.parse(`"${match[1]}"`);
        } catch {
          continue;
        }
        if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !isUnderRoots(cwd, roots)) break;
        placed = true;
      }
      const prompt = promptFromLine(raw, roots, since, now);
      if (prompt) prompts.push(prompt);
    }
  } catch {
    // Unreadable file: what was read so far still counts.
  } finally {
    reader.close();
    stream.destroy();
  }
  return prompts;
}

/** No allowed folders = nothing is opened at all. */
export async function scanTranscripts(options: ScanOptions): Promise<ScanResult> {
  const now = options.now ?? Date.now();
  const since = now - WINDOW_MS;
  const empty: ScanResult = { scannedAt: now, partial: false, files: 0, prompts: 0, lines: [], candidates: [] };
  if (options.roots.length === 0) return empty;

  const deadline = Date.now() + (options.maxMs ?? MAX_SCAN_MS);
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const transcripts = recentTranscripts(options.projectsDir ?? defaultProjectsDir(), since);
  const prompts: Prompt[] = [];
  let files = 0;
  let partial = transcripts.length > maxFiles;
  for (const file of transcripts.slice(0, maxFiles)) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    prompts.push(...(await readPrompts(file, options.roots, since, now, deadline)));
    files += 1;
  }

  const lines = collectLines(prompts);
  const candidates = findCandidates(lines);
  const cited = new Set(candidates.flatMap((candidate) => candidate.ids));
  return { scannedAt: now, partial, files, prompts: prompts.length, lines: lines.filter((line) => cited.has(line.id)), candidates };
}

export function readIdeasStore(storePath: string): IdeasStore | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(storePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as IdeasStore).scannedAt !== "number") return null;
    const store = parsed as IdeasStore;
    return {
      ...store,
      lines: Array.isArray(store.lines) ? store.lines : [],
      proposals: Array.isArray(store.proposals) ? store.proposals : [],
      rejected: Array.isArray(store.rejected) ? store.rejected.filter(isDecided) : [],
      created: Array.isArray(store.created) ? store.created.filter(isDecided) : []
    };
  } catch {
    return null;
  }
}

/** A new scan replaces the candidates and proposals and keeps what the owner already decided. */
export function writeIdeasStore(storePath: string, result: ScanResult, proposals: Proposal[] = []): void {
  const previous = readIdeasStore(storePath);
  saveStore(storePath, { ...result, proposals, rejected: previous?.rejected ?? [], created: previous?.created ?? [] });
}

function saveStore(storePath: string, store: IdeasStore): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath);
}

export type AutomationIdeasDeps = {
  storePath: string;
  /** The opt-in switch; read on every trigger so a Settings change needs no restart. */
  enabled: () => boolean;
  roots: () => readonly string[];
  projectsDir?: string;
  now?: () => number;
  /** One model call with the candidates; absent or null = no proposals, the candidates stay. */
  complete?: (request: { system: string; user: string }) => Promise<string | null>;
  skillsDir?: string;
  /** Proposals changed: a scan finished or the owner decided one. */
  onChange?: () => void;
};

export class AutomationIdeas {
  private running: Promise<ScanResult | null> | null = null;
  private lastScanAt: number | null | undefined;

  constructor(private readonly deps: AutomationIdeasDeps) {}

  /** Called on every Stop hook; scans at most once a week and only when switched on. */
  onSessionStop(): void {
    if (!this.deps.enabled() || this.running) return;
    if (this.lastScanAt === undefined) this.lastScanAt = readIdeasStore(this.deps.storePath)?.scannedAt ?? null;
    if (scanDue(this.lastScanAt, this.now())) void this.scan();
  }

  /** One scan at a time; null when switched off or no folder is allowed. */
  scan(): Promise<ScanResult | null> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<ScanResult | null> {
    const roots = this.deps.roots();
    if (!this.deps.enabled() || roots.length === 0) return null;
    const now = this.now();
    // Set before the scan: a failed one waits for next week instead of retrying on every Stop.
    this.lastScanAt = now;
    try {
      const result = await scanTranscripts({ roots, now, projectsDir: this.deps.projectsDir });
      const proposals = await this.propose(result);
      writeIdeasStore(this.deps.storePath, result, proposals);
      // Counts only: prompt text never goes to the log.
      console.log(
        `[automation-ideas] ${result.files} transcripts, ${result.prompts} prompts, ${result.candidates.length} candidates, ` +
          `${proposals.length} proposals` +
          (result.partial ? " (partial)" : "")
      );
      this.deps.onChange?.();
      return result;
    } catch (err) {
      console.warn("[automation-ideas] scan failed:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** The only place a model is asked: candidates in, proposals that pass the local checks out. */
  private async propose(result: ScanResult): Promise<Proposal[]> {
    if (!this.deps.complete) return [];
    const previous = readIdeasStore(this.deps.storePath);
    const open = withoutDecided(result.candidates, [...(previous?.rejected ?? []), ...(previous?.created ?? [])]);
    if (open.length === 0) return [];
    const reply = await this.deps.complete(buildProposalRequest(open));
    if (reply === null) return [];
    const raw = parseProposals(reply);
    const accepted = acceptProposals(raw, result.lines, listSkills(this.skillsDir()));
    if (accepted.length < raw.length) console.log(`[automation-ideas] ${raw.length - accepted.length} proposals failed the local check`);
    return accepted;
  }

  /** Proposals waiting for the owner; empty when switched off. */
  ideas(): IdeaView[] {
    if (!this.deps.enabled()) return [];
    const store = readIdeasStore(this.deps.storePath);
    if (!store) return [];
    return store.proposals.map(({ id, name, description, steps, count, days, ids }) => ({
      id,
      name,
      description,
      steps,
      count,
      days,
      evidence: ids.flatMap((lineId) => store.lines.find((line) => line.id === lineId)?.text ?? [])
    }));
  }

  /** The owner's explicit accept: the only path that writes a skill. */
  create(id: string): CreateResult {
    return this.decide(id, (proposal) => createSkill(this.skillsDir(), proposal)) ?? { ok: false, reason: "invalid" };
  }

  /** "Never": the phrasings go to the exclusions and are not proposed again. */
  reject(id: string): void {
    this.decide(id, () => ({ ok: true, path: "" }), "rejected");
  }

  /** "Not now": dropped from the list; next week's scan may propose it again. */
  later(id: string): void {
    this.decide(id, () => ({ ok: true, path: "" }), null);
  }

  private decide(
    id: string,
    act: (proposal: Proposal) => CreateResult,
    keepAs: "created" | "rejected" | null = "created"
  ): CreateResult | null {
    const store = readIdeasStore(this.deps.storePath);
    const proposal = store?.proposals.find((entry) => entry.id === id);
    if (!store || !proposal) return null;
    const result = act(proposal);
    // A name that is already taken can never be created, so that proposal leaves the list too.
    if (!result.ok && result.reason !== "exists") return result;
    const texts = proposal.ids.flatMap((lineId) => store.lines.find((line) => line.id === lineId)?.text ?? []);
    const decided: Decided = { name: proposal.name, texts, at: this.now(), ...(result.ok && result.path ? { path: result.path } : {}) };
    saveStore(this.deps.storePath, {
      ...store,
      proposals: store.proposals.filter((entry) => entry.id !== id),
      ...(keepAs && result.ok ? { [keepAs]: [...store[keepAs], decided] } : {})
    });
    this.deps.onChange?.();
    return result;
  }

  private skillsDir(): string {
    return this.deps.skillsDir ?? defaultSkillsDir();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
