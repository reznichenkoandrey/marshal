// Files under <userData>/workflows (#280): definitions.json, state.json, the
// per-workflow run journal and memory. Read only on rearm, never on a timer.

import fs from "node:fs";
import path from "node:path";

import { memoryKey, SCHEMA_VERSION, validateDefinition, type WorkflowDefinition } from "./definition.ts";

export const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
export const ERROR_MAX_CHARS = 500;

export type RunStatus = "ok" | "failed" | "skipped";

export interface RunRecord {
  at: number;
  status: RunStatus;
  /** `timeout`, `exit`, `missing-binary`, `contract`, `auth`, `slept`, `overlap`, `daily-cap`. */
  reason?: string;
  say?: string;
  silent?: boolean;
  charts?: number;
  durationMs?: number;
  error?: string;
}

export interface WorkflowState {
  nextRunAt: number | null;
  /** `cron|timezone` that `nextRunAt` was computed for. */
  schedule: string;
  /** Failed runs in a row; three pause the workflow. */
  failures: number;
  paused: "failing" | "auth" | null;
  /** When the one retry of a failed run is due. */
  retryAt: number | null;
  /** Local date (in the workflow's zone) the run counter belongs to. */
  runsDay: string;
  runsCount: number;
}

export function emptyState(): WorkflowState {
  return { nextRunAt: null, schedule: "", failures: 0, paused: null, retryAt: null, runsDay: "", runsCount: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * Parses a JSON file. A missing file is `undefined`; one that does not parse is
 * moved aside as `*.corrupt-<ts>` (never silently erased) and also `undefined`.
 */
function readJson(file: string, now: number): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const aside = `${file}.corrupt-${now}`;
    try {
      fs.renameSync(file, aside);
      console.warn(`[workflows] ${path.basename(file)} does not parse; moved to ${path.basename(aside)}`);
    } catch (err) {
      console.warn(`[workflows] ${path.basename(file)} does not parse and could not be moved:`, err instanceof Error ? err.message : err);
    }
    return undefined;
  }
}

export class WorkflowStore {
  constructor(private readonly dir: string) {}

  private file(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  /** Valid definitions from definitions.json; an invalid entry is skipped with its reasons logged. */
  loadDefinitions(now: number): WorkflowDefinition[] {
    const raw = readJson(this.file("definitions.json"), now);
    if (raw === undefined) return [];
    const list = isRecord(raw) && Array.isArray(raw.workflows) ? raw.workflows : null;
    if (!isRecord(raw) || raw.schemaVersion !== SCHEMA_VERSION || !list) {
      console.warn(`[workflows] definitions.json is not { schemaVersion: ${SCHEMA_VERSION}, workflows: [...] }; ignored`);
      return [];
    }
    const definitions: WorkflowDefinition[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      const result = validateDefinition(entry);
      if (!result.ok) {
        console.warn("[workflows] definition skipped:", result.errors.join("; "));
      } else if (seen.has(result.definition.id)) {
        console.warn(`[workflows] duplicate id "${result.definition.id}" skipped`);
      } else {
        seen.add(result.definition.id);
        definitions.push(result.definition);
      }
    }
    return definitions;
  }

  /** The raw entries of definitions.json, invalid ones included, so an edit never erases them. */
  private rawEntries(now: number): unknown[] {
    const raw = readJson(this.file("definitions.json"), now);
    return isRecord(raw) && raw.schemaVersion === SCHEMA_VERSION && Array.isArray(raw.workflows) ? raw.workflows : [];
  }

  /** Adds or replaces one definition by id; every other entry stays as written. */
  upsertDefinition(definition: WorkflowDefinition, now: number): void {
    const entries = this.rawEntries(now);
    const index = entries.findIndex((entry) => isRecord(entry) && entry.id === definition.id);
    if (index >= 0) entries[index] = definition;
    else entries.push(definition);
    writeAtomic(this.file("definitions.json"), JSON.stringify({ schemaVersion: SCHEMA_VERSION, workflows: entries }, null, 2));
  }

  saveDefinitions(definitions: WorkflowDefinition[]): void {
    writeAtomic(this.file("definitions.json"), JSON.stringify({ schemaVersion: SCHEMA_VERSION, workflows: definitions }, null, 2));
  }

  loadState(now: number): Map<string, WorkflowState> {
    const raw = readJson(this.file("state.json"), now);
    const states = new Map<string, WorkflowState>();
    if (!isRecord(raw)) return states;
    for (const [id, value] of Object.entries(raw)) {
      if (!isRecord(value)) continue;
      states.set(id, {
        nextRunAt: typeof value.nextRunAt === "number" ? value.nextRunAt : null,
        schedule: typeof value.schedule === "string" ? value.schedule : "",
        failures: typeof value.failures === "number" ? value.failures : 0,
        paused: value.paused === "failing" || value.paused === "auth" ? value.paused : null,
        retryAt: typeof value.retryAt === "number" ? value.retryAt : null,
        runsDay: typeof value.runsDay === "string" ? value.runsDay : "",
        runsCount: typeof value.runsCount === "number" ? value.runsCount : 0
      });
    }
    return states;
  }

  saveState(states: Map<string, WorkflowState>): void {
    try {
      writeAtomic(this.file("state.json"), JSON.stringify(Object.fromEntries(states), null, 2));
    } catch (err) {
      console.warn("[workflows] state save failed:", err instanceof Error ? err.message : err);
    }
  }

  /** Appends one journal line; a journal over 2 MB is rotated to `<id>.1.ndjson` first. */
  appendRun(id: string, record: RunRecord): void {
    const file = this.file("runs", `${id}.ndjson`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > JOURNAL_MAX_BYTES) {
        fs.renameSync(file, this.file("runs", `${id}.1.ndjson`));
      }
      const line = record.error ? { ...record, error: record.error.slice(0, ERROR_MAX_CHARS) } : record;
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch (err) {
      console.warn("[workflows] journal write failed:", err instanceof Error ? err.message : err);
    }
  }

  readRuns(id: string): RunRecord[] {
    try {
      return fs
        .readFileSync(this.file("runs", `${id}.ndjson`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunRecord);
    } catch {
      return [];
    }
  }

  /** Memory from the last successful run, or null when the prompt or tool list changed since. */
  readMemory(definition: WorkflowDefinition, now: number): Record<string, unknown> | null {
    const raw = readJson(this.file("memory", `${definition.id}.json`), now);
    if (!isRecord(raw) || raw.key !== memoryKey(definition) || !isRecord(raw.memory)) return null;
    return raw.memory;
  }

  writeMemory(definition: WorkflowDefinition, memory: Record<string, unknown>): void {
    writeAtomic(this.file("memory", `${definition.id}.json`), JSON.stringify({ key: memoryKey(definition), memory }));
  }
}
