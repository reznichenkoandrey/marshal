import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Idle budget for all Marshal processes except the speech model (#281). */
export const IDLE_BUDGET_BYTES = 300 * 1024 * 1024;
/** The resident speech model process; loaded on demand, so outside the idle budget. */
export const SPEECH_MODEL_PROCESS = "whisper-server";

export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
}

export interface ProcessFootprint {
  pid: number;
  name: string;
  bytes: number;
}

export interface FootprintSummary {
  processes: ProcessFootprint[];
  /** Everything except the speech model — what the idle budget applies to. */
  appBytes: number;
  /** Footprint of the speech model process, or null when it is not loaded. */
  modelBytes: number | null;
  overBudget: boolean;
}

/** Parses `ps -A -o pid=,ppid=,comm=`; the name is the executable's basename. */
export function parsePsOutput(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), name: path.basename(match[3]) });
  }
  return rows;
}

/** The root and every process below it. */
export function processTree(rows: readonly ProcessRow[], rootPid: number): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return [];
  const tree: ProcessRow[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const next = queue.shift() as ProcessRow;
    tree.push(next);
    queue.push(...(byParent.get(next.pid) ?? []));
  }
  return tree;
}

/** pid -> phys_footprint bytes from `footprint --noCategories -f bytes <pids>`. */
export function parseFootprintOutput(text: string): Map<number, number> {
  const result = new Map<number, number>();
  for (const match of text.matchAll(/\[(\d+)\]:.*?Footprint:\s*(\d+)\s*B/gu)) {
    result.set(Number(match[1]), Number(match[2]));
  }
  return result;
}

export function summarizeFootprint(processes: readonly ProcessFootprint[], budgetBytes = IDLE_BUDGET_BYTES): FootprintSummary {
  const sorted = [...processes].sort((a, b) => b.bytes - a.bytes);
  const model = sorted.filter((entry) => entry.name === SPEECH_MODEL_PROCESS);
  const appBytes = sorted.filter((entry) => entry.name !== SPEECH_MODEL_PROCESS).reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    processes: sorted,
    appBytes,
    modelBytes: model.length > 0 ? model.reduce((sum, entry) => sum + entry.bytes, 0) : null,
    overBudget: appBytes > budgetBytes
  };
}

export function formatMegabytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Measures the process tree under `rootPid` with macOS `footprint` — the same
 * number Activity Monitor shows as Memory. macOS only.
 */
export async function measureFootprint(rootPid: number): Promise<FootprintSummary> {
  const { stdout: psText } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,comm="]);
  const tree = processTree(parsePsOutput(psText), rootPid);
  if (tree.length === 0) throw new Error(`No process with pid ${rootPid}.`);
  const { stdout } = await execFileAsync("footprint", ["--noCategories", "-f", "bytes", ...tree.map((row) => String(row.pid))], {
    maxBuffer: 4 * 1024 * 1024
  });
  const bytes = parseFootprintOutput(stdout);
  return summarizeFootprint(
    tree.filter((row) => bytes.has(row.pid)).map((row) => ({ pid: row.pid, name: row.name, bytes: bytes.get(row.pid) as number }))
  );
}

export type FootprintGroup = "main" | "renderer" | "gpu" | "service" | "helpers";
export type FootprintShare = { group: FootprintGroup; mb: number };

const GROUP_ORDER: readonly FootprintGroup[] = ["main", "renderer", "gpu", "service", "helpers"];

/** Electron's helper names carry their role; Swift helpers (ptt-monitor…) are "helpers". */
export function footprintGroup(name: string): FootprintGroup {
  if (/\(Renderer\)/u.test(name)) return "renderer";
  if (/\(GPU\)/u.test(name)) return "gpu";
  if (/ Helper\b/u.test(name)) return "service";
  if (/^(Electron|Marshal)$/u.test(name)) return "main";
  return "helpers";
}

/** Per-role split of the idle footprint for the home dashboard (#398); the speech model is left out. */
export function groupFootprint(processes: readonly ProcessFootprint[]): FootprintShare[] {
  const totals = new Map<FootprintGroup, number>();
  for (const entry of processes) {
    if (entry.name === SPEECH_MODEL_PROCESS) continue;
    const group = footprintGroup(entry.name);
    totals.set(group, (totals.get(group) ?? 0) + entry.bytes);
  }
  return GROUP_ORDER.filter((group) => totals.has(group)).map((group) => ({ group, mb: Math.round((totals.get(group) ?? 0) / 1024 ** 2) }));
}
