// Model protocol of the voice dashboards (#279, docs/VOICE_DASHBOARDS.md §3).
// The model answers with NDJSON events: `plan` first (cards appear as
// skeletons), then one `query` per chart it wants filled, `keep` for a chart
// of the previous dashboard that stays as it is, and `title`. Everything here
// is pure: the service feeds it text, tests feed it garbage.

import type { SummaryMessages } from "../captions/summary-prompt.ts";

export type ChartKind = "line" | "bar";
export type SourceId = "git" | "github";
export type Metric = "commits" | "issues" | "prs";
export type GroupBy = "day" | "week" | "author" | "state" | "label";

/**
 * A query is a choice from fixed options, never a command line: main builds
 * the `git` / `gh` arguments itself, so the read-only rule lives in one place.
 */
export interface ChartQuery {
  source: SourceId;
  metric: Metric;
  groupBy: GroupBy;
  days: number;
}

export interface PlannedChart {
  id: string;
  title: string;
  kind: ChartKind;
  source: SourceId;
}

export type ProtocolEvent =
  | { type: "plan"; charts: PlannedChart[] }
  | { type: "query"; id: string; query: ChartQuery }
  | { type: "keep"; id: string }
  | { type: "title"; value: string };

export const MAX_CHARTS = 8;
export const MAX_LINE_BYTES = 64 * 1024;
export const MAX_DAYS = 365;
const MAX_TITLE_CHARS = 120;

const GROUPS: Record<SourceId, { metrics: Metric[]; groupBy: GroupBy[] }> = {
  git: { metrics: ["commits"], groupBy: ["day", "week", "author"] },
  github: { metrics: ["issues", "prs"], groupBy: ["day", "week", "author", "state", "label"] }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value.trim().slice(0, MAX_TITLE_CHARS) : "");

const isSource = (value: unknown): value is SourceId => value === "git" || value === "github";

/** Null when the query names anything outside the fixed options. `days` is clamped, not rejected. */
export function validateQuery(value: unknown): ChartQuery | null {
  if (!isRecord(value) || !isSource(value.source)) return null;
  const allowed = GROUPS[value.source];
  const metric = allowed.metrics.find((candidate) => candidate === value.metric);
  const groupBy = allowed.groupBy.find((candidate) => candidate === value.groupBy);
  if (!metric || !groupBy) return null;
  const days = typeof value.days === "number" && Number.isFinite(value.days) ? Math.round(value.days) : 7;
  return { source: value.source, metric, groupBy, days: Math.min(MAX_DAYS, Math.max(1, days)) };
}

function parsePlan(value: unknown): PlannedChart[] {
  if (!Array.isArray(value)) return [];
  const charts: PlannedChart[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = text(item.id);
    if (id === "" || !isSource(item.source) || charts.some((chart) => chart.id === id)) continue;
    charts.push({ id, title: text(item.title) || id, kind: item.kind === "bar" ? "bar" : "line", source: item.source });
    if (charts.length === MAX_CHARTS) break;
  }
  return charts;
}

/** One line of the model's answer. Null for anything that is not a usable event — never throws. */
export function parseProtocolLine(line: string): ProtocolEvent | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("{") || Buffer.byteLength(trimmed, "utf8") > MAX_LINE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "plan": {
      const charts = parsePlan(value.charts);
      return charts.length > 0 ? { type: "plan", charts } : null;
    }
    case "query": {
      const id = text(value.id);
      const query = validateQuery(value);
      return id !== "" && query ? { type: "query", id, query } : null;
    }
    case "keep": {
      const id = text(value.id);
      return id !== "" ? { type: "keep", id } : null;
    }
    case "title": {
      const title = text(value.value);
      return title !== "" ? { type: "title", value: title } : null;
    }
    default:
      return null;
  }
}

/**
 * Turns streamed deltas into complete lines. A line that outgrows the limit
 * is dropped up to its newline instead of being buffered without bound.
 */
export class LineSplitter {
  private buffer = "";
  private overflow = false;

  push(delta: string): string[] {
    const lines: string[] = [];
    for (const piece of delta.split(/(\n)/u)) {
      if (piece === "\n") {
        if (!this.overflow) lines.push(this.buffer);
        this.buffer = "";
        this.overflow = false;
      } else if (!this.overflow) {
        this.buffer += piece;
        if (this.buffer.length > MAX_LINE_BYTES) {
          this.buffer = "";
          this.overflow = true;
        }
      }
    }
    return lines;
  }

  /** The unterminated tail: a complete last line, or a JSON object cut mid-way that the parser rejects. */
  flush(): string[] {
    const rest = this.overflow ? "" : this.buffer;
    this.buffer = "";
    this.overflow = false;
    return rest === "" ? [] : [rest];
  }
}

const SYSTEM_PROMPT = `You plan data dashboards for a desktop assistant. Answer ONLY with NDJSON: one JSON object per line, no prose, no markdown, no code fences.

Line types, in this order:
{"type":"title","value":"<short dashboard title>"}
{"type":"plan","charts":[{"id":"c1","title":"<chart title>","kind":"line"|"bar","source":"git"|"github"}]}
{"type":"query","id":"c1","source":"git","metric":"commits","groupBy":"day","days":7}
{"type":"keep","id":"c2"}

Rules:
- "plan" lists every chart of the dashboard, at most ${MAX_CHARTS}. Ids are short and unique.
- Each chart gets exactly one "query" or one "keep".
- "keep" is only for a chart of the current dashboard that the request does not change: keep its id, title, kind and source in the plan. It is not queried again.
- A new or changed chart gets a new id and a "query".
- Sources and their options:
  git (commit history of the repository): metric "commits"; groupBy "day" | "week" | "author".
  github (issues and pull requests of the repository): metric "issues" | "prs"; groupBy "day" | "week" | "author" | "state" | "label".
- "days" is how far back to look, 1 to ${MAX_DAYS}.
- Use "line" for day and week, "bar" for author, state and label.
- You cannot run anything else. If the request needs data outside these sources, plan the closest charts these sources can give.
- Write the title and chart titles in the language of the request. Keep identifiers and technical terms as they are.`;

export interface CurrentChart extends PlannedChart {
  query?: ChartQuery;
}

/** The request plus, for a follow-up, the dashboard it edits — so the model can `keep` what it does not touch. */
export function buildDashboardMessages(request: string, current: { title: string; charts: CurrentChart[] } | null): SummaryMessages {
  const parts: string[] = [];
  if (current && current.charts.length > 0) {
    parts.push(
      "Current dashboard (the request below edits it):\n" +
        JSON.stringify({
          title: current.title,
          charts: current.charts.map(({ id, title, kind, source, query }) => ({ id, title, kind, source, query }))
        })
    );
  }
  parts.push("Request:\n" + request.trim());
  return { system: SYSTEM_PROMPT, systemInstructions: SYSTEM_PROMPT, referenceContext: "", user: parts.join("\n\n") };
}
