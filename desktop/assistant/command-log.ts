// Voice command log for the home dashboard (#398): what the owner said, where
// the dispatcher sent it and how it ended. Ring buffer on disk, no timers —
// "no answer" is derived from age when the log is read (#281).

import fs from "node:fs";
import path from "node:path";

export const COMMAND_LOG_LIMIT = 200;
/** A command still unresolved after this long had no answer. */
export const NO_ANSWER_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type CommandTargetKind = "session" | "feature" | "general";
export type CommandOutcome = "pending" | "sent" | "answered" | "failed";
export type CommandDisplayOutcome = Exclude<CommandOutcome, "pending"> | "pending" | "no_answer";

export type CommandEntry = {
  id: number;
  text: string;
  at: number;
  target: string | null;
  kind: CommandTargetKind | null;
  outcome: CommandOutcome;
  /** When the outcome became final (answered / failed), ms since epoch. */
  doneAt: number | null;
};

export type CommandRoute = { kind: CommandTargetKind; target: string; outcome: "sent" | "answered" | "failed" };

export type CommandRow = {
  text: string;
  at: number;
  target: string | null;
  kind: CommandTargetKind | null;
  outcome: CommandDisplayOutcome;
  /** How long the command took to end, or null while it has not. */
  durationMs: number | null;
};

function lastIndex(log: readonly CommandEntry[], matches: (entry: CommandEntry) => boolean): number {
  for (let index = log.length - 1; index >= 0; index -= 1) if (matches(log[index] as CommandEntry)) return index;
  return -1;
}

export function appendCommand(log: readonly CommandEntry[], text: string, now: number): CommandEntry[] {
  const id = (log.at(-1)?.id ?? 0) + 1;
  const entry: CommandEntry = { id, text, at: now, target: null, kind: null, outcome: "pending", doneAt: null };
  return [...log, entry].slice(-COMMAND_LOG_LIMIT);
}

/** The dispatcher routed the newest command still in flight; nothing in flight = nothing to change. */
export function routeCommand(log: readonly CommandEntry[], route: CommandRoute, now: number): CommandEntry[] {
  const index = lastIndex(log, (entry) => entry.outcome === "pending" && now - entry.at < NO_ANSWER_MS);
  if (index < 0) return [...log];
  const final = route.outcome !== "sent";
  return log.map((entry, at) =>
    at === index ? { ...entry, kind: route.kind, target: route.target, outcome: route.outcome, doneAt: final ? now : null } : entry
  );
}

/** A session answered: the newest command sent to it is answered. */
export function answerFromSession(log: readonly CommandEntry[], name: string, now: number): CommandEntry[] {
  const index = lastIndex(log, (entry) => entry.outcome === "sent" && entry.target === name && now - entry.at < NO_ANSWER_MS);
  if (index < 0) return [...log];
  return log.map((entry, at) => (at === index ? { ...entry, outcome: "answered", doneAt: now } : entry));
}

export function displayOutcome(entry: CommandEntry, now: number): CommandDisplayOutcome {
  if (entry.outcome === "answered" || entry.outcome === "failed") return entry.outcome;
  if (now - entry.at >= NO_ANSWER_MS) return entry.outcome === "sent" ? "sent" : "no_answer";
  return entry.outcome;
}

export function commandRows(log: readonly CommandEntry[], now: number, limit = 6): CommandRow[] {
  return log
    .slice(-limit)
    .reverse()
    .map((entry) => ({
      text: entry.text,
      at: entry.at,
      target: entry.target,
      kind: entry.kind,
      outcome: displayOutcome(entry, now),
      durationMs: entry.doneAt === null ? null : entry.doneAt - entry.at
    }));
}

function startOfLocalDay(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Commands in the current period and the one before it: today vs yesterday, or 7 days vs the 7 before. */
export function commandCounts(log: readonly CommandEntry[], now: number, days: 1 | 7): { current: number; previous: number } {
  const start = startOfLocalDay(now) - (days - 1) * DAY_MS;
  const previousStart = start - days * DAY_MS;
  let current = 0;
  let previous = 0;
  for (const entry of log) {
    if (entry.at >= start && entry.at <= now) current += 1;
    else if (entry.at >= previousStart && entry.at < start) previous += 1;
  }
  return { current, previous };
}

export function parseCommandLog(text: string): CommandEntry[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is CommandEntry =>
        typeof entry === "object" && entry !== null && typeof entry.id === "number" && typeof entry.text === "string" && typeof entry.at === "number"
    ).slice(-COMMAND_LOG_LIMIT);
  } catch {
    return [];
  }
}

/** File-backed log in `<userData>/assistant/command-log.json`; written on every change, read once. */
export class CommandLog {
  private entries: CommandEntry[];

  constructor(private readonly file: string, private readonly onChange: () => void = () => {}) {
    this.entries = fs.existsSync(file) ? parseCommandLog(fs.readFileSync(file, "utf8")) : [];
  }

  add(text: string, now = Date.now()): void {
    this.save(appendCommand(this.entries, text, now));
  }

  route(route: CommandRoute, now = Date.now()): void {
    this.save(routeCommand(this.entries, route, now));
  }

  answered(name: string, now = Date.now()): void {
    this.save(answerFromSession(this.entries, name, now));
  }

  list(): readonly CommandEntry[] {
    return this.entries;
  }

  private save(next: CommandEntry[]): void {
    this.entries = next;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(next));
    } catch (err) {
      console.warn(`[assistant] command log not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.onChange();
  }
}
