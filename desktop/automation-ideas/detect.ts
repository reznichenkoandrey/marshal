// Repeated requests in Claude Code history → candidates for a skill, rule or
// script (#273, docs/AUTOMATION_IDEAS.md). Everything here is pure: no model,
// no disk. A model only ever sees the candidates (stage B), and its proposal
// is re-counted here before it is accepted.

import path from "node:path";

import { projectOf } from "../assistant/assistant-state.ts";
import { isUnderRoots } from "../claude-code/context-router.ts";

export const WINDOW_MS = 7 * 24 * 60 * 60_000;
// "ok", "далі", "yes do it": an answer, not a request worth automating.
export const MIN_PROMPT_CHARS = 12;
// A long prompt is a one-off brief, and nothing that long is kept outside the transcript.
export const MAX_PROMPT_CHARS = 400;
// Starting value from the spec; to be calibrated on real history.
export const SIMILARITY_THRESHOLD = 0.6;
export const MIN_REPEATS = 3;
export const MIN_DAYS = 2;
export const MIN_REPEATS_ONE_PROJECT = 5;

export type Prompt = { text: string; day: string; project: string };

/** One distinct normalised prompt with where and when it was said. */
export type Line = { id: string; text: string; count: number; days: string[]; projects: Record<string, number> };

export type Candidate = {
  id: string;
  representative: string;
  ids: string[];
  count: number;
  days: string[];
  projects: Record<string, number>;
};

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "is", "it", "this", "that",
  "please", "pls", "can", "you", "me", "my", "i", "we", "do", "be", "now", "then", "just", "all", "so",
  "і", "й", "та", "а", "в", "у", "на", "з", "із", "до", "по", "за", "для", "це", "цей", "ця", "що", "як", "ще",
  "будь", "ласка", "мені", "ти", "я", "ми", "тепер", "потім", "теж", "же", "ж", "б", "би", "все", "там", "тут", "про"
]);

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : ""
    )
    .join("\n");
}

function localDay(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Lowercase, one space between words, and everything that differs between two
 * sayings of the same request removed: session ids, temp-file paths, numbers.
 * `#123` stays as the token `#N` — it marks "a task", whichever one.
 */
export function normalizePrompt(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, " ")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, " ")
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/\S+/gu, " ")
    .replace(/#\d+/gu, "#N")
    .replace(/\d+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * The owner's prompt from one transcript line, or null. Only `type: "user"`
 * text typed in a session under the allowed folders (#303) inside the window;
 * tool results, subagent traffic, meta lines and harness-injected blocks
 * (`<command-name>`, `<task-notification>`…) are not requests. A line without
 * `cwd` or `timestamp` cannot be placed, so it is skipped.
 */
export function promptFromLine(raw: string, roots: readonly string[], since: number, now: number): Prompt | null {
  // Most lines are tool traffic, some of them megabytes: skip them unparsed.
  if (!raw.includes('"user"')) return null;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (o.type !== "user" || o.isSidechain === true || o.isMeta === true) return null;
  if (typeof o.cwd !== "string" || !path.isAbsolute(o.cwd) || !isUnderRoots(o.cwd, roots)) return null;
  const time = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  if (!Number.isFinite(time) || time < since || time > now) return null;
  const text = normalizePrompt(contentText((o.message as { content?: unknown } | undefined)?.content));
  if (text.length < MIN_PROMPT_CHARS || text.length > MAX_PROMPT_CHARS || text.startsWith("<")) return null;
  return { text, day: localDay(time), project: projectOf(o.cwd) };
}

/** Identical normalised prompts folded into lines `L1`, `L2`… in first-seen order. */
export function collectLines(prompts: Iterable<Prompt>): Line[] {
  const byText = new Map<string, Line>();
  for (const prompt of prompts) {
    let line = byText.get(prompt.text);
    if (!line) {
      line = { id: `L${byText.size + 1}`, text: prompt.text, count: 0, days: [], projects: {} };
      byText.set(prompt.text, line);
    }
    line.count += 1;
    if (!line.days.includes(prompt.day)) line.days.push(prompt.day);
    line.projects[prompt.project] = (line.projects[prompt.project] ?? 0) + 1;
  }
  return [...byText.values()];
}

export function tokenize(text: string): Set<string> {
  const words = text.match(/#N|[\p{L}_][\p{L}\p{N}_-]*/gu) ?? [];
  return new Set(words.filter((word) => !STOP_WORDS.has(word)));
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function summarize(lines: readonly Line[]): Pick<Candidate, "count" | "days" | "projects"> {
  const days = new Set<string>();
  const projects: Record<string, number> = {};
  let count = 0;
  for (const line of lines) {
    count += line.count;
    for (const day of line.days) days.add(day);
    for (const [project, times] of Object.entries(line.projects)) projects[project] = (projects[project] ?? 0) + times;
  }
  return { count, days: [...days].sort(), projects };
}

/** ≥ 3 repeats on ≥ 2 days, or ≥ 5 repeats inside one project. */
export function isRepeated(stats: Pick<Candidate, "count" | "days" | "projects">): boolean {
  if (stats.count >= MIN_REPEATS && stats.days.length >= MIN_DAYS) return true;
  return Object.values(stats.projects).some((times) => times >= MIN_REPEATS_ONE_PROJECT);
}

/**
 * Lines that say the same thing in different words, grouped by token overlap.
 * Ukrainian and English phrasings share no tokens, so they form separate
 * clusters; merging them would take a model call the spec does not spend.
 */
export function clusterLines(lines: readonly Line[]): Line[][] {
  // ponytail: greedy against each cluster's first line, O(lines × clusters); fine for a week of prompts.
  const clusters: { seed: Set<string>; lines: Line[] }[] = [];
  for (const line of lines) {
    const tokens = tokenize(line.text);
    if (tokens.size === 0) continue;
    const home = clusters.find((cluster) => jaccard(cluster.seed, tokens) >= SIMILARITY_THRESHOLD);
    if (home) home.lines.push(line);
    else clusters.push({ seed: tokens, lines: [line] });
  }
  return clusters.map((cluster) => cluster.lines);
}

/** Clusters that repeat often enough, most repeated first; the longest phrasing represents each. */
export function findCandidates(lines: readonly Line[]): Candidate[] {
  return clusterLines(lines)
    .map((cluster) => ({ cluster, stats: summarize(cluster) }))
    .filter(({ stats }) => isRepeated(stats))
    .sort((a, b) => b.stats.count - a.stats.count)
    .map(({ cluster, stats }, index) => ({
      id: `C${index + 1}`,
      representative: cluster.reduce((longest, line) => (line.text.length > longest.text.length ? line : longest)).text,
      ids: cluster.map((line) => line.id),
      ...stats
    }));
}

/**
 * A model's proposal is accepted only on local evidence (spec 4.5): every id
 * it cites exists, those lines really add up to ≥ 3 repeats on ≥ 2 days, and
 * its name does not collide with a skill that already exists.
 */
export function verifyProposal(
  proposal: { name: string; ids: readonly string[] },
  lines: readonly Line[],
  existingSkills: readonly string[]
): boolean {
  if (proposal.ids.length === 0) return false;
  const cited = [...new Set(proposal.ids)].map((id) => lines.find((line) => line.id === id));
  if (cited.some((line) => line === undefined)) return false;
  const stats = summarize(cited as Line[]);
  if (stats.count < MIN_REPEATS || stats.days.length < MIN_DAYS) return false;
  const name = proposal.name.trim().toLowerCase();
  return name !== "" && !existingSkills.some((skill) => skill.toLowerCase() === name);
}

/** Once a week: true when the last scan is older than this week's Monday 00:00 local. */
export function scanDue(lastScanAt: number | null, now: number): boolean {
  if (lastScanAt === null) return true;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return lastScanAt < monday.getTime();
}
