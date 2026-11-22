import { describe, expect, it } from "vitest";

import { isDailyOrRarer, nextRunAt, parseCron, type CronRule } from "../desktop/workflows/cron.ts";
import { isReadOnlyTool, memoryKey, toolWords, validateDefinition } from "../desktop/workflows/definition.ts";

const KYIV = "Europe/Kyiv";

function rule(expression: string): CronRule {
  const parsed = parseCron(expression);
  if (!parsed) throw new Error(`bad cron ${expression}`);
  return parsed;
}

function next(expression: string, after: string, timeZone = KYIV): string | null {
  const at = nextRunAt(rule(expression), timeZone, Date.parse(after));
  return at === null ? null : new Date(at).toISOString();
}

describe("parseCron", () => {
  it("expands lists, ranges and steps", () => {
    expect(rule("*/15 9-11 * * 1,3").minutes).toEqual([0, 15, 30, 45]);
    expect(rule("*/15 9-11 * * 1,3").hours).toEqual([9, 10, 11]);
    expect(rule("0 0 * * 7").daysOfWeek).toEqual([0]);
    expect(rule("5/20 * * * *").minutes).toEqual([5, 25, 45]);
  });

  it("rejects anything that is not five valid fields", () => {
    for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "5-1 * * * *", "@daily", "* * * * mon", "0 9 * * * *"]) {
      expect(parseCron(bad), bad).toBeNull();
    }
  });

  it("tells daily rules from rules that run through the day", () => {
    expect(isDailyOrRarer(rule("0 9 * * *"))).toBe(true);
    expect(isDailyOrRarer(rule("0 9 * * 1"))).toBe(true);
    expect(isDailyOrRarer(rule("0 * * * *"))).toBe(false);
    expect(isDailyOrRarer(rule("0 9,18 * * *"))).toBe(false);
  });
});

describe("nextRunAt", () => {
  it("finds the next slot in the workflow's zone, strictly after the given instant", () => {
    expect(next("0 9 * * *", "2026-11-22T06:00:00Z")).toBe("2026-11-22T07:00:00.000Z");
    expect(next("0 9 * * *", "2026-11-22T07:00:00Z")).toBe("2026-11-23T07:00:00.000Z");
    expect(next("*/20 * * * *", "2026-11-22T07:05:30Z")).toBe("2026-11-22T07:20:00.000Z");
    expect(next("0 9 * * *", "2026-11-22T06:00:00Z", "America/New_York")).toBe("2026-11-22T14:00:00.000Z");
  });

  it("applies the day-of-week and day-of-month fields", () => {
    // 2026-11-22 is a Sunday.
    expect(next("0 9 * * 1", "2026-11-22T12:00:00Z")).toBe("2026-11-23T07:00:00.000Z");
    expect(next("0 9 1 * *", "2026-11-22T12:00:00Z")).toBe("2026-12-01T07:00:00.000Z");
    // Both restricted: either one matches (Friday the 27th comes before the 1st).
    expect(next("0 9 1 * 5", "2026-11-22T12:00:00Z")).toBe("2026-11-27T07:00:00.000Z");
    expect(next("0 0 29 2 *", "2026-11-22T12:00:00Z")).toBe("2028-02-28T22:00:00.000Z");
    expect(next("0 0 31 2 *", "2026-11-22T12:00:00Z")).toBeNull();
  });

  it("keeps the wall-clock hour across spring forward", () => {
    // Kyiv: 2026-03-29 03:00 becomes 04:00 (UTC+2 to UTC+3).
    expect(next("0 9 * * *", "2026-03-28T08:00:00Z")).toBe("2026-03-29T06:00:00.000Z");
    expect(next("0 4 * * *", "2026-03-28T08:00:00Z")).toBe("2026-03-29T01:00:00.000Z");
    expect(next("0 9 * * *", "2026-03-08T12:00:00Z", "America/New_York")).toBe("2026-03-08T13:00:00.000Z");
    expect(next("30 3 * * *", "2026-03-07T12:00:00Z", "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
  });

  it("runs a time inside the spring gap right after the gap, once", () => {
    expect(next("30 3 * * *", "2026-03-28T12:00:00Z")).toBe("2026-03-29T01:30:00.000Z");
    expect(next("30 3 * * *", "2026-03-29T01:30:00Z")).toBe("2026-03-30T00:30:00.000Z");
    expect(next("0 * * * *", "2026-03-29T00:30:00Z")).toBe("2026-03-29T01:00:00.000Z");
    expect(next("0 * * * *", "2026-03-29T01:00:00Z")).toBe("2026-03-29T02:00:00.000Z");
  });

  it("runs a time repeated by fall back once", () => {
    // Kyiv: 2026-10-25 04:00 becomes 03:00, so 03:30 happens twice.
    const first = next("30 3 * * *", "2026-10-24T12:00:00Z");
    expect(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]).toContain(first);
    expect(next("30 3 * * *", first as string)).toBe("2026-10-26T01:30:00.000Z");
    expect(next("0 9 * * *", "2026-10-24T12:00:00Z")).toBe("2026-10-25T07:00:00.000Z");
  });
});

describe("isReadOnlyTool", () => {
  it("splits names into words", () => {
    expect(toolWords("list_issues")).toEqual(["list", "issues"]);
    expect(toolWords("getPullRequest")).toEqual(["get", "pull", "request"]);
    expect(toolWords("WebFetch")).toEqual(["web", "fetch"]);
  });

  it("allows tools whose name reads and does not write", () => {
    for (const tool of ["mcp__github__list_issues", "mcp__sentry__search_errors", "mcp__db__query", "WebFetch", "WebSearch", "Read", "Grep", "Glob", "mcp__x__get_settings", "mcp__x__get_posts"]) {
      expect(isReadOnlyTool(tool), tool).toBe(true);
    }
  });

  it("refuses writes, mixed names and names without a reading verb", () => {
    for (const tool of ["mcp__github__create_issue", "mcp__github__get_or_create_label", "mcp__mail__send_message", "mcp__x__list_and_delete", "mcp__x__setValue", "Bash", "Edit", "Write", "mcp__x__run"]) {
      expect(isReadOnlyTool(tool), tool).toBe(false);
    }
  });

  it("judges the tool, not the server it lives on", () => {
    expect(isReadOnlyTool("mcp__post-office__list_parcels")).toBe(true);
    expect(isReadOnlyTool("mcp__reader__delete_item")).toBe(false);
  });
});

const VALID = {
  id: "wf_issues",
  name: "New issues",
  schedule: { cron: "0 9 * * *", timezone: KYIV },
  prompt: "List new issues.",
  allowedTools: ["mcp__github__list_issues"],
  mcpServers: ["github"]
};

function errorsOf(patch: Record<string, unknown>): string[] {
  const result = validateDefinition({ ...VALID, ...patch });
  return result.ok ? [] : result.errors;
}

describe("validateDefinition", () => {
  it("fills the defaults", () => {
    const result = validateDefinition(VALID);
    expect(result).toEqual({
      ok: true,
      definition: {
        ...VALID,
        enabled: true,
        catchUp: "skip",
        runAtStart: false,
        timeoutMs: 600_000,
        maxRunsPerDay: 24,
        model: "haiku",
        writes: false,
        language: null
      }
    });
  });

  it("defaults catchUp to once for rules that run through the day", () => {
    const result = validateDefinition({ ...VALID, schedule: { cron: "0 * * * *", timezone: KYIV } });
    expect(result.ok && result.definition.catchUp).toBe("once");
    const explicit = validateDefinition({ ...VALID, catchUp: "once" });
    expect(explicit.ok && explicit.definition.catchUp).toBe("once");
  });

  it("rejects a bad schedule, zone, limits and empty prompt", () => {
    expect(errorsOf({ schedule: { cron: "every morning", timezone: KYIV } })).toHaveLength(1);
    expect(errorsOf({ schedule: { cron: "0 9 * * *", timezone: "Mars/Olympus" } })).toHaveLength(1);
    expect(errorsOf({ schedule: { cron: "0 9 * * *" } })).toHaveLength(1);
    expect(errorsOf({ timeoutMs: 5 })).toHaveLength(1);
    expect(errorsOf({ timeoutMs: 99_999_999 })).toHaveLength(1);
    expect(errorsOf({ maxRunsPerDay: 0 })).toHaveLength(1);
    expect(errorsOf({ maxRunsPerDay: 1.5 })).toHaveLength(1);
    expect(errorsOf({ prompt: "  " })).toHaveLength(1);
    expect(errorsOf({ id: "../etc" })).toHaveLength(1);
    expect(errorsOf({ catchUp: "always" })).toHaveLength(1);
    expect(validateDefinition(null).ok).toBe(false);
  });

  it("rejects write tools, masks and tools of an unlisted server", () => {
    expect(errorsOf({ allowedTools: ["mcp__github__create_issue"] })).toEqual(['allowedTools: "mcp__github__create_issue" is not a read-only tool']);
    expect(errorsOf({ allowedTools: ["mcp__github__*"] })).toHaveLength(1);
    expect(errorsOf({ allowedTools: ["Bash(git log:*)"] })).toHaveLength(1);
    expect(errorsOf({ allowedTools: ["mcp__sentry__list_issues"] })).toEqual(['allowedTools: "mcp__sentry__list_issues" needs "sentry" in mcpServers']);
    expect(errorsOf({ allowedTools: "mcp__github__list_issues" })).toHaveLength(1);
  });

  it("never accepts write access from the file", () => {
    expect(errorsOf({ writes: true })).toEqual(["writes cannot be enabled in a definition file"]);
  });

  it("reports every problem at once", () => {
    expect(errorsOf({ prompt: "", timeoutMs: 1, writes: true }).length).toBe(3);
  });
});

describe("memoryKey", () => {
  const base = { prompt: "p", allowedTools: ["Read", "Grep"] };

  it("ignores tool order and changes with the prompt or the tool list", () => {
    expect(memoryKey({ prompt: "p", allowedTools: ["Grep", "Read"] })).toBe(memoryKey(base));
    expect(memoryKey({ ...base, prompt: "q" })).not.toBe(memoryKey(base));
    expect(memoryKey({ ...base, allowedTools: ["Read"] })).not.toBe(memoryKey(base));
  });
});
