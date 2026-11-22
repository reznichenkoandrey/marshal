// Read-only data sources of the voice dashboards (#279): the commit history
// (`git log`) and GitHub issues / pull requests (`gh issue list`, `gh pr list`)
// of one repository folder. Main builds every argument from fixed options, so
// the model can neither pick a subcommand nor inject a flag.

import { execFile } from "node:child_process";

import type { ChartQuery, GroupBy } from "./protocol.ts";

export interface Row {
  label: string;
  value: number;
}

export interface SourceRecord {
  /** YYYY-MM-DD */
  date: string;
  author: string;
  state: string;
  labels: string[];
}

export interface ChartStats {
  total: number;
  min: number;
  max: number;
  avg: number;
}

export type Exec = (file: string, args: string[], cwd: string) => Promise<string>;

const MAX_CATEGORIES = 12;
const MAX_RECORDS = 1000;
const MAX_COMMITS = 50000;
const EXEC_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

const toMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const toDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function localDay(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** First day of a `days`-long window that ends on `today`. */
export function windowStart(today: string, days: number): string {
  return toDay(toMs(today) - (days - 1) * DAY_MS);
}

/** Monday of the week `day` falls in. */
export function weekStart(day: string): string {
  const ms = toMs(day);
  return toDay(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS);
}

/**
 * Counts records into chart rows. Time groupings list every day or week of
 * the window, empty ones as zero, so a quiet day is a dip and not a gap.
 */
export function aggregate(records: SourceRecord[], groupBy: GroupBy, days: number, today: string): Row[] {
  const start = windowStart(today, days);
  const inWindow = records.filter((record) => record.date >= start && record.date <= today);
  const counts = new Map<string, number>();
  const add = (label: string): void => {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  };

  if (groupBy === "day" || groupBy === "week") {
    const key = groupBy === "day" ? (day: string): string => day : weekStart;
    const step = groupBy === "day" ? DAY_MS : 7 * DAY_MS;
    for (let ms = toMs(key(start)); ms <= toMs(today); ms += step) counts.set(toDay(ms), 0);
    for (const record of inWindow) add(key(record.date));
    return [...counts].map(([label, value]) => ({ label, value }));
  }

  for (const record of inWindow) {
    if (groupBy === "label") record.labels.forEach(add);
    else add((groupBy === "author" ? record.author : record.state) || "—");
  }
  return [...counts]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, MAX_CATEGORIES);
}

export function chartStats(rows: Row[]): ChartStats | null {
  if (rows.length === 0) return null;
  const values = rows.map((row) => row.value);
  const total = values.reduce((sum, value) => sum + value, 0);
  return { total, min: Math.min(...values), max: Math.max(...values), avg: Math.round((total / values.length) * 10) / 10 };
}

/** `git log --date=short --format=%ad%x09%an` output. */
export function parseGitLog(output: string): SourceRecord[] {
  const records: SourceRecord[] = [];
  for (const line of output.split("\n")) {
    const [date, author] = line.split("\t");
    if (date && /^\d{4}-\d{2}-\d{2}$/u.test(date)) records.push({ date, author: author?.trim() ?? "", state: "", labels: [] });
  }
  return records;
}

/** `gh issue list --json createdAt,state,author,labels` (same shape for `gh pr list`). */
export function parseGhList(output: string): SourceRecord[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) return [];
  const records: SourceRecord[] = [];
  for (const item of parsed as Array<Record<string, unknown>>) {
    const createdAt = typeof item?.createdAt === "string" ? item.createdAt.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(createdAt)) continue;
    const author = (item.author as { login?: unknown } | null)?.login;
    const labels = Array.isArray(item.labels) ? (item.labels as Array<{ name?: unknown }>) : [];
    records.push({
      date: createdAt,
      author: typeof author === "string" ? author : "",
      state: typeof item.state === "string" ? item.state.toLowerCase() : "",
      labels: labels.map((label) => label?.name).filter((name): name is string => typeof name === "string")
    });
  }
  return records;
}

/** The whole allowlist: `git log` and `gh issue|pr list`, each with fixed flags. */
export function sourceCommand(query: ChartQuery, today: string): { file: string; args: string[] } {
  const start = windowStart(today, query.days);
  if (query.source === "git") {
    return {
      file: "git",
      args: ["log", `--since=${start}T00:00:00`, "--date=short", "--format=%ad%x09%an", "-n", String(MAX_COMMITS)]
    };
  }
  return {
    file: "gh",
    args: [
      query.metric === "prs" ? "pr" : "issue",
      "list",
      "--state",
      "all",
      "--limit",
      String(MAX_RECORDS),
      "--search",
      `created:>=${start}`,
      "--json",
      "createdAt,state,author,labels"
    ]
  };
}

const defaultExec: Exec = (file, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const code = (err as NodeJS.ErrnoException).code;
      // One line is enough to say what went wrong; the rest of stderr is noise.
      reject(new Error(code === "ENOENT" ? `${file}: not installed` : (stderr.trim().split("\n")[0] ?? "") || err.message));
    });
  });

export async function runQuery(
  query: ChartQuery,
  folder: string,
  today: string = localDay(),
  exec: Exec = defaultExec
): Promise<Row[]> {
  const { file, args } = sourceCommand(query, today);
  const output = await exec(file, args, folder);
  const records = query.source === "git" ? parseGitLog(output) : parseGhList(output);
  return aggregate(records, query.groupBy, query.days, today);
}
