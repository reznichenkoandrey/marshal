import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DashboardService, type DashboardState, type StreamModel } from "../desktop/dashboards/dashboard-service.ts";
import {
  buildDashboardMessages,
  LineSplitter,
  MAX_CHARTS,
  MAX_LINE_BYTES,
  parseProtocolLine,
  validateQuery,
  type ChartQuery
} from "../desktop/dashboards/protocol.ts";
import {
  aggregate,
  chartStats,
  parseGhList,
  parseGitLog,
  runQuery,
  sourceCommand,
  weekStart,
  windowStart,
  type SourceRecord
} from "../desktop/dashboards/sources.ts";

const record = (date: string, extra: Partial<SourceRecord> = {}): SourceRecord => ({ date, author: "ann", state: "open", labels: [], ...extra });

describe("dashboard protocol", () => {
  it("parses plan, query, keep and title lines", () => {
    expect(parseProtocolLine('{"type":"title","value":"Коміти за тиждень"}')).toEqual({ type: "title", value: "Коміти за тиждень" });
    expect(parseProtocolLine('{"type":"plan","charts":[{"id":"c1","title":"By day","kind":"line","source":"git"}]}')).toEqual({
      type: "plan",
      charts: [{ id: "c1", title: "By day", kind: "line", source: "git" }]
    });
    expect(parseProtocolLine('{"type":"query","id":"c1","source":"git","metric":"commits","groupBy":"day","days":7}')).toEqual({
      type: "query",
      id: "c1",
      query: { source: "git", metric: "commits", groupBy: "day", days: 7 }
    });
    expect(parseProtocolLine(' {"type":"keep","id":"c3"} ')).toEqual({ type: "keep", id: "c3" });
  });

  it("ignores anything that is not a usable event", () => {
    const junk = [
      "",
      "   ",
      "Here is your dashboard:",
      "```json",
      '{"type":"query","source":"git","metric":"commits","groupBy":"day"}',
      '{"type":"keep"}',
      '{"type":"shell","cmd":"rm -rf /"}',
      '{"type":"plan","charts":[]}',
      '{"type":"plan","charts":[{"id":"c1","source":"postgres"}]}',
      '{"type":"query","id":"c1","sou',
      "[1,2,3]",
      `{"type":"title","value":"${"x".repeat(MAX_LINE_BYTES)}"}`
    ];
    for (const line of junk) expect(parseProtocolLine(line), line.slice(0, 40)).toBeNull();
  });

  it("caps the plan and drops duplicate ids", () => {
    const charts = Array.from({ length: 12 }, (_unused, index) => ({ id: `c${index}`, title: "t", kind: "bar", source: "github" }));
    charts.push({ id: "c0", title: "again", kind: "bar", source: "github" });
    const event = parseProtocolLine(JSON.stringify({ type: "plan", charts }));
    expect(event?.type === "plan" && event.charts.length).toBe(MAX_CHARTS);
  });

  it("accepts only the fixed query options and clamps days", () => {
    expect(validateQuery({ source: "git", metric: "issues", groupBy: "day", days: 7 })).toBeNull();
    expect(validateQuery({ source: "git", metric: "commits", groupBy: "label", days: 7 })).toBeNull();
    expect(validateQuery({ source: "github", metric: "prs", groupBy: "state; rm", days: 7 })).toBeNull();
    expect(validateQuery({ source: "github", metric: "prs", groupBy: "state", days: 99999 })?.days).toBe(365);
    expect(validateQuery({ source: "github", metric: "prs", groupBy: "state", days: -3 })?.days).toBe(1);
    expect(validateQuery({ source: "github", metric: "prs", groupBy: "state", days: "30; --exec" })?.days).toBe(7);
  });

  it("splits streamed deltas into lines and survives a line cut mid-JSON", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"type":"keep",')).toEqual([]);
    expect(splitter.push('"id":"c1"}\n{"type":"ke')).toEqual(['{"type":"keep","id":"c1"}']);
    const tail = splitter.flush();
    expect(tail).toEqual(['{"type":"ke']);
    expect(parseProtocolLine(tail[0] ?? "")).toBeNull();
    expect(splitter.flush()).toEqual([]);
  });

  it("drops an oversized line up to its newline", () => {
    const splitter = new LineSplitter();
    expect(splitter.push("x".repeat(MAX_LINE_BYTES + 1))).toEqual([]);
    expect(splitter.push('more\n{"type":"keep","id":"c1"}\n')).toEqual(['{"type":"keep","id":"c1"}']);
  });

  it("gives the model the current dashboard on a follow-up", () => {
    const fresh = buildDashboardMessages("коміти по днях", null);
    expect(fresh.user).not.toContain("Current dashboard");
    const query: ChartQuery = { source: "git", metric: "commits", groupBy: "day", days: 7 };
    const followUp = buildDashboardMessages("add PRs by author", { title: "T", charts: [{ id: "c1", title: "A", kind: "line", source: "git", query }] });
    expect(followUp.user).toContain('"id":"c1"');
    expect(followUp.user).toContain("add PRs by author");
  });
});

describe("dashboard sources", () => {
  it("computes the window and the week start", () => {
    expect(windowStart("2026-11-22", 7)).toBe("2026-11-16");
    expect(windowStart("2026-03-01", 1)).toBe("2026-03-01");
    expect(weekStart("2026-11-22")).toBe("2026-11-16");
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
  });

  it("fills empty days with zero and ignores records outside the window", () => {
    const rows = aggregate([record("2026-11-20"), record("2026-11-20"), record("2026-11-22"), record("2026-11-01")], "day", 3, "2026-11-22");
    expect(rows).toEqual([
      { label: "2026-11-20", value: 2 },
      { label: "2026-11-21", value: 0 },
      { label: "2026-11-22", value: 1 }
    ]);
  });

  it("groups by week, author, state and label", () => {
    const records = [
      record("2026-11-10", { author: "bob", state: "merged", labels: ["bug", "area:ui"] }),
      record("2026-11-17", { author: "ann", labels: ["bug"] }),
      record("2026-11-18", { author: "ann", state: "" })
    ];
    expect(aggregate(records, "week", 14, "2026-11-22")).toEqual([
      { label: "2026-11-09", value: 1 },
      { label: "2026-11-16", value: 2 }
    ]);
    expect(aggregate(records, "author", 14, "2026-11-22")).toEqual([
      { label: "ann", value: 2 },
      { label: "bob", value: 1 }
    ]);
    expect(aggregate(records, "state", 14, "2026-11-22").map((row) => row.label).sort()).toEqual(["merged", "open", "—"].sort());
    expect(aggregate(records, "label", 14, "2026-11-22")[0]).toEqual({ label: "bug", value: 2 });
  });

  it("computes stats", () => {
    expect(chartStats([])).toBeNull();
    expect(chartStats([{ label: "a", value: 1 }, { label: "b", value: 4 }, { label: "c", value: 2 }])).toEqual({ total: 7, min: 1, max: 4, avg: 2.3 });
  });

  it("parses git log and gh output, Cyrillic authors included", () => {
    expect(parseGitLog("2026-11-20\tАндрій Р\nnot a line\n\n2026-11-21\tann\n")).toEqual([
      { date: "2026-11-20", author: "Андрій Р", state: "", labels: [] },
      { date: "2026-11-21", author: "ann", state: "", labels: [] }
    ]);
    const gh = JSON.stringify([
      { createdAt: "2026-11-20T10:00:00Z", state: "MERGED", author: { login: "ann" }, labels: [{ name: "bug" }] },
      { createdAt: null, state: "OPEN" },
      { createdAt: "2026-11-21T10:00:00Z", state: "OPEN", author: null, labels: [] }
    ]);
    expect(parseGhList(gh)).toEqual([
      { date: "2026-11-20", author: "ann", state: "merged", labels: ["bug"] },
      { date: "2026-11-21", author: "", state: "open", labels: [] }
    ]);
  });

  it("builds only read-only git and gh commands", () => {
    const git = sourceCommand({ source: "git", metric: "commits", groupBy: "day", days: 7 }, "2026-11-22");
    expect(git.file).toBe("git");
    expect(git.args[0]).toBe("log");
    expect(git.args).toContain("--since=2026-11-16T00:00:00");
    const prs = sourceCommand({ source: "github", metric: "prs", groupBy: "state", days: 30 }, "2026-11-22");
    expect(prs.file).toBe("gh");
    expect(prs.args.slice(0, 2)).toEqual(["pr", "list"]);
    expect(prs.args).toContain("created:>=2026-10-24");
    expect(sourceCommand({ source: "github", metric: "issues", groupBy: "day", days: 1 }, "2026-11-22").args.slice(0, 2)).toEqual(["issue", "list"]);
  });

  it("runs a query through the injected exec in the chosen folder", async () => {
    const calls: Array<{ file: string; cwd: string }> = [];
    const rows = await runQuery({ source: "git", metric: "commits", groupBy: "author", days: 7 }, "/repo", "2026-11-22", async (file, _args, cwd) => {
      calls.push({ file, cwd });
      return "2026-11-21\tann\n2026-11-22\tann\n";
    });
    expect(calls).toEqual([{ file: "git", cwd: "/repo" }]);
    expect(rows).toEqual([{ label: "ann", value: 2 }]);
  });
});

describe("DashboardService", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const answer =
    (lines: string[]): StreamModel =>
    async (_messages, _maxTokens, onDelta) => {
      // Deltas that do not align with lines, as a real stream delivers them.
      const text = lines.join("\n");
      for (let index = 0; index < text.length; index += 17) onDelta(text.slice(index, index + 17));
      return text;
    };

  async function setup(model: StreamModel | null, run?: (query: ChartQuery) => Promise<{ label: string; value: number }[]>) {
    dir = await mkdtemp(path.join(os.tmpdir(), "marshal-dash-"));
    const states: DashboardState[] = [];
    const ran: ChartQuery[] = [];
    let current = model;
    const service = new DashboardService({
      dir,
      model: () => current,
      onChange: (state) => states.push(structuredClone(state)),
      run: async (query) => {
        ran.push(query);
        return run ? run(query) : [{ label: "2026-11-22", value: ran.length }];
      }
    });
    await service.load();
    return { service, states, ran, setModel: (next: StreamModel) => (current = next) };
  }

  const PLAN = '{"type":"plan","charts":[{"id":"c1","title":"Commits","kind":"line","source":"git"},{"id":"c2","title":"PRs","kind":"bar","source":"github"}]}';
  const Q1 = '{"type":"query","id":"c1","source":"git","metric":"commits","groupBy":"day","days":7}';
  const Q2 = '{"type":"query","id":"c2","source":"github","metric":"prs","groupBy":"state","days":30}';

  it("asks for a folder before building", async () => {
    const { service, ran } = await setup(answer([PLAN, Q1]));
    await service.build("commits");
    expect(service.state().error).toMatch(/folder/u);
    expect(ran).toEqual([]);
  });

  it("reports a missing provider", async () => {
    const { service } = await setup(null);
    await service.setFolder("/repo");
    await service.build("commits");
    expect(service.state().error).toMatch(/model/u);
  });

  it("shows skeletons from the plan, then fills each chart and saves", async () => {
    const { service, states } = await setup(answer(['{"type":"title","value":"Week"}', "noise", PLAN, Q1, Q2]));
    await service.setFolder("/repo");
    await service.build("commits and prs");

    const skeleton = states.find((state) => state.dashboard?.charts.length === 2);
    expect(skeleton?.dashboard?.charts.every((chart) => chart.status === "pending" && !chart.rows)).toBe(true);

    const final = service.state();
    expect(final.busy).toBe(false);
    expect(final.dashboard?.title).toBe("Week");
    expect(final.dashboard?.charts.map((chart) => chart.status)).toEqual(["ready", "ready"]);
    expect(final.dashboard?.charts[0]?.stats?.total).toBe(1);

    const saved = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")) as DashboardState;
    expect(saved.folder).toBe("/repo");
    expect(saved.dashboard?.charts).toHaveLength(2);
  });

  it("does not query a kept chart again on a follow-up", async () => {
    const { service, ran, setModel } = await setup(answer([PLAN, Q1, Q2]));
    await service.setFolder("/repo");
    await service.build("commits and prs");
    expect(ran).toHaveLength(2);
    const before = service.state().dashboard?.charts[0];

    setModel(
      answer([
        '{"type":"plan","charts":[{"id":"c1","title":"Commits","kind":"line","source":"git"},{"id":"c3","title":"Issues","kind":"bar","source":"github"}]}',
        '{"type":"keep","id":"c1"}',
        '{"type":"keep","id":"unknown"}',
        '{"type":"query","id":"c3","source":"github","metric":"issues","groupBy":"label","days":30}',
        // A second query for the same chart is ignored: one per chart per build.
        '{"type":"query","id":"c3","source":"github","metric":"issues","groupBy":"day","days":30}'
      ])
    );
    await service.build("replace prs with issues by label");

    expect(ran).toHaveLength(3);
    expect(ran[2]?.metric).toBe("issues");
    const charts = service.state().dashboard?.charts ?? [];
    expect(charts.map((chart) => chart.id)).toEqual(["c1", "c3"]);
    expect(charts[0]?.rows).toEqual(before?.rows);
    expect(charts[0]?.updatedAt).toBe(before?.updatedAt);
    expect(charts[1]?.query?.groupBy).toBe("label");
  });

  it("keeps the previous dashboard when the model returns no plan", async () => {
    const { service, setModel } = await setup(answer([PLAN, Q1, Q2]));
    await service.setFolder("/repo");
    await service.build("commits and prs");
    setModel(answer(["Sorry, I cannot do that."]));
    await service.build("something else");
    expect(service.state().error).toMatch(/no charts/u);
    expect(service.state().dashboard?.charts).toHaveLength(2);
  });

  it("marks a failed query and a chart with no query", async () => {
    const { service } = await setup(answer([PLAN, Q1]), async () => {
      throw new Error("gh: not installed");
    });
    await service.setFolder("/repo");
    await service.build("commits and prs");
    const charts = service.state().dashboard?.charts ?? [];
    expect(charts[0]).toMatchObject({ status: "error", error: "gh: not installed" });
    expect(charts[1]?.status).toBe("empty");
  });

  it("refreshes every stored query without the model", async () => {
    const { service, ran, setModel } = await setup(answer([PLAN, Q1, Q2]));
    await service.setFolder("/repo");
    await service.build("commits and prs");
    setModel(async () => {
      throw new Error("the model must not be called on refresh");
    });
    await service.refresh();
    expect(ran).toHaveLength(4);
    expect(service.state().error).toBeNull();
  });

  it("stops at the build timeout and marks unfinished charts", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "marshal-dash-"));
    const service = new DashboardService({
      dir,
      buildTimeoutMs: 20,
      onChange: () => undefined,
      run: () => new Promise(() => undefined),
      model: () => async (_messages, _maxTokens, onDelta, signal) => {
        onDelta(`${PLAN}\n${Q1}\n`);
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        throw new Error("aborted");
      }
    });
    await service.load();
    await service.setFolder("/repo");
    await service.build("commits");
    const charts = service.state().dashboard?.charts ?? [];
    expect(service.state().busy).toBe(false);
    expect(charts.map((chart) => chart.status)).toEqual(["timeout", "empty"]);
  });
});
