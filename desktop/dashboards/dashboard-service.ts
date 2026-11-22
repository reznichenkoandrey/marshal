// Builds and refreshes the voice dashboard (#279). The model plans charts and
// names a query per chart (protocol.ts); this service runs the queries
// (sources.ts) and keeps the result on disk. It owns no timer: data is fetched
// on build and on refresh, and both are only ever called by the open window.

import { promises as fs } from "node:fs";
import path from "node:path";

import type { SummaryMessages } from "../captions/summary-prompt.ts";
import { translate, type MessageKey, type MessageParams, type UiLanguage } from "../i18n/catalog.ts";
import {
  buildDashboardMessages,
  LineSplitter,
  parseProtocolLine,
  type ChartQuery,
  type PlannedChart,
  type ProtocolEvent
} from "./protocol.ts";
import { chartStats, runQuery, type ChartStats, type Row } from "./sources.ts";

export type ChartStatus = "pending" | "ready" | "error" | "empty" | "timeout";

export interface Chart extends PlannedChart {
  status: ChartStatus;
  query?: ChartQuery;
  rows?: Row[];
  stats?: ChartStats | null;
  updatedAt?: string;
  error?: string;
}

export interface Dashboard {
  title: string;
  prompt: string;
  charts: Chart[];
}

export interface DashboardState {
  folder: string | null;
  dashboard: Dashboard | null;
  busy: boolean;
  error: string | null;
}

/** The `streamMessages` half of the captions SummaryStreamer: one provider stack for the whole app. */
export type StreamModel = (
  messages: SummaryMessages,
  maxTokens: number,
  onDelta: (delta: string) => void,
  signal: AbortSignal
) => Promise<string>;

export interface DashboardServiceDeps {
  /** `<userData>/dashboards` */
  dir: string;
  /** Null when no provider is configured. */
  model: () => StreamModel | null;
  onChange: (state: DashboardState) => void;
  language?: () => UiLanguage;
  run?: (query: ChartQuery, folder: string) => Promise<Row[]>;
  buildTimeoutMs?: number;
}

const BUILD_TIMEOUT_MS = 180_000;
const MAX_TOKENS = 1500;
const STATE_FILE = "state.json";

/** A chart still pending when its build or refresh ended: it keeps the data it had, or says it got none. */
function settle(chart: Chart): void {
  if (chart.status !== "pending") return;
  chart.status = chart.rows?.some((row) => row.value > 0) ? "ready" : chart.query ? "timeout" : "empty";
}

export class DashboardService {
  private folder: string | null = null;
  private dashboard: Dashboard | null = null;
  private error: string | null = null;
  private job: AbortController | null = null;
  private readonly run: (query: ChartQuery, folder: string) => Promise<Row[]>;

  constructor(private readonly deps: DashboardServiceDeps) {
    this.run = deps.run ?? ((query, folder) => runQuery(query, folder));
  }

  private tr(key: MessageKey, params?: MessageParams): string {
    return translate(this.deps.language?.() ?? "en", key, params);
  }

  state(): DashboardState {
    return { folder: this.folder, dashboard: this.dashboard, busy: this.job !== null, error: this.error };
  }

  private emit(): void {
    this.deps.onChange(this.state());
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.deps.dir, STATE_FILE), "utf8")) as Partial<DashboardState>;
      this.folder = typeof saved.folder === "string" ? saved.folder : null;
      this.dashboard = saved.dashboard && Array.isArray(saved.dashboard.charts) ? saved.dashboard : null;
      this.dashboard?.charts.forEach(settle);
    } catch {
      // First run or an unreadable file: start empty.
    }
    this.emit();
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(this.deps.dir, { recursive: true });
      await fs.writeFile(
        path.join(this.deps.dir, STATE_FILE),
        JSON.stringify({ folder: this.folder, dashboard: this.dashboard }, null, 2),
        "utf8"
      );
    } catch (err) {
      console.warn("[dashboards] cannot save:", err instanceof Error ? err.message : err);
    }
  }

  async setFolder(folder: string): Promise<void> {
    this.folder = folder;
    this.error = null;
    await this.save();
    this.emit();
  }

  /** Closing the window ends whatever is running: nothing refreshes in the background. */
  cancel(): void {
    this.job?.abort();
  }

  private begin(): AbortController | null {
    if (this.job) {
      this.error = this.tr("dash.error.busy");
    } else if (!this.folder) {
      this.error = this.tr("dash.error.noFolder");
    } else {
      this.error = null;
      this.job = new AbortController();
    }
    this.emit();
    return this.job && this.error === null ? this.job : null;
  }

  private async fill(chart: Chart, folder: string, signal: AbortSignal): Promise<void> {
    if (!chart.query) return;
    chart.status = "pending";
    chart.error = undefined;
    this.emit();
    try {
      const rows = await this.run(chart.query, folder);
      if (signal.aborted) return;
      chart.rows = rows;
      chart.stats = chartStats(rows);
      chart.updatedAt = new Date().toISOString();
      chart.status = rows.some((row) => row.value > 0) ? "ready" : "empty";
    } catch (err) {
      if (signal.aborted) return;
      chart.status = "error";
      chart.error = err instanceof Error ? err.message : String(err);
    }
    this.emit();
  }

  /** Re-runs the stored query of every chart. The model is not involved. */
  async refresh(): Promise<void> {
    if (!this.dashboard || this.dashboard.charts.length === 0) return;
    const job = this.begin();
    const folder = this.folder;
    if (!job || !folder) return;
    try {
      await Promise.all(this.dashboard.charts.map((chart) => this.fill(chart, folder, job.signal)));
    } finally {
      this.dashboard.charts.forEach(settle);
      await this.save();
      this.job = null;
      this.emit();
    }
  }

  /** A new dashboard, or a follow-up that edits the current one: charts the model keeps are not queried again. */
  async build(prompt: string): Promise<void> {
    const request = prompt.trim();
    if (request === "") return;
    const model = this.deps.model();
    if (!model) {
      this.error = this.tr("dash.error.noProvider");
      this.emit();
      return;
    }
    const job = this.begin();
    const folder = this.folder;
    if (!job || !folder) return;

    const previous = this.dashboard;
    const next: Dashboard = { title: previous?.title ?? request, prompt: request, charts: [] };
    const settled = new Set<string>();
    const queries: Promise<void>[] = [];
    const timeout = setTimeout(() => job.abort(), this.deps.buildTimeoutMs ?? BUILD_TIMEOUT_MS);

    const apply = (event: ProtocolEvent): void => {
      if (event.type === "title") {
        next.title = event.value;
      } else if (event.type === "plan") {
        // One plan per build; a second one would orphan queries already running.
        if (next.charts.length > 0) return;
        next.charts = event.charts.map((chart) => ({ ...chart, status: "pending" }));
        this.dashboard = next;
      } else {
        const chart = next.charts.find((candidate) => candidate.id === event.id);
        if (!chart || settled.has(chart.id)) return;
        if (event.type === "keep") {
          const kept = previous?.charts.find((candidate) => candidate.id === event.id);
          if (!kept?.query) return;
          settled.add(chart.id);
          Object.assign(chart, { query: kept.query, rows: kept.rows, stats: kept.stats, updatedAt: kept.updatedAt, status: kept.status, error: kept.error });
        } else {
          settled.add(chart.id);
          chart.query = event.query;
          chart.source = event.query.source;
          queries.push(this.fill(chart, folder, job.signal));
        }
      }
      this.emit();
    };

    const lines = new LineSplitter();
    const feed = (chunk: string[]): void => {
      for (const line of chunk) {
        const event = parseProtocolLine(line);
        if (event) apply(event);
        else if (line.trim() !== "") console.warn("[dashboards] ignored model line:", line.slice(0, 120));
      }
    };

    try {
      await model(buildDashboardMessages(request, previous), MAX_TOKENS, (delta) => feed(lines.push(delta)), job.signal);
      feed(lines.flush());
      await Promise.all(queries);
      if (next.charts.length === 0) this.error = this.tr("dash.error.noPlan");
    } catch (err) {
      if (!job.signal.aborted) this.error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timeout);
      next.charts.forEach(settle);
      if (next.charts.length > 0) await this.save();
      this.job = null;
      this.emit();
    }
  }
}
