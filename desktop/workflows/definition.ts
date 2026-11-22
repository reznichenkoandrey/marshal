// Workflow definition: schema, validation and the read-only tool filter (#280).
// Pure. Stage 1 has no builder, so a definition is JSON written by hand and
// everything here runs when the file is loaded.

import { createHash } from "node:crypto";

import { isDailyOrRarer, isValidTimeZone, parseCron } from "./cron.ts";

export const SCHEMA_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 600_000;
export const MIN_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const DEFAULT_MAX_RUNS_PER_DAY = 24;
export const MAX_RUNS_PER_DAY_LIMIT = 288;
export const DEFAULT_MODEL = "haiku";

export type CatchUp = "once" | "skip";

export interface WorkflowDefinition {
  id: string;
  name: string;
  enabled: boolean;
  schedule: { cron: string; timezone: string };
  catchUp: CatchUp;
  runAtStart: boolean;
  timeoutMs: number;
  maxRunsPerDay: number;
  model: string;
  prompt: string;
  allowedTools: string[];
  mcpServers: string[];
  writes: boolean;
  language: "uk" | "en" | null;
}

export type ValidationResult = { ok: true; definition: WorkflowDefinition } | { ok: false; errors: string[] };

const READ_VERBS = new Set(["get", "list", "read", "search", "query", "fetch"]);
const WRITE_VERBS = new Set(["create", "update", "delete", "write", "send", "post", "merge", "close", "set"]);
// Built-in Claude Code tools that only read and carry no verb in their name.
const READ_ONLY_BUILTINS = new Set(["Read", "Grep", "Glob"]);

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MCP_TOOL = /^mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__([A-Za-z0-9_-]+)$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Splits `list_issues`, `listIssues` and `WebFetch` into lower-case words. */
export function toolWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** The MCP server a tool belongs to, or null for a built-in tool. */
export function mcpServerOf(tool: string): string | null {
  return MCP_TOOL.exec(tool)?.[1] ?? null;
}

/**
 * A tool may run without write access when its own name (not the server's)
 * has a reading verb and no writing verb. Unknown shapes count as writes.
 */
export function isReadOnlyTool(tool: string): boolean {
  if (READ_ONLY_BUILTINS.has(tool)) return true;
  const words = toolWords(MCP_TOOL.exec(tool)?.[2] ?? tool);
  return words.some((word) => READ_VERBS.has(word)) && !words.some((word) => WRITE_VERBS.has(word));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

function intInRange(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** Checks one hand-written definition and fills the defaults; every problem is reported, not just the first. */
export function validateDefinition(raw: unknown): ValidationResult {
  if (!isRecord(raw)) return { ok: false, errors: ["definition is not an object"] };
  const errors: string[] = [];

  const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : null;
  if (!id) errors.push("id must be 1-64 characters of letters, digits, _ or -");
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null;
  if (!name) errors.push("name is empty");
  const prompt = typeof raw.prompt === "string" && raw.prompt.trim() ? raw.prompt : null;
  if (!prompt) errors.push("prompt is empty");

  const schedule = isRecord(raw.schedule) ? raw.schedule : {};
  const cron = typeof schedule.cron === "string" ? schedule.cron.trim() : "";
  const rule = parseCron(cron);
  if (!rule) errors.push(`schedule.cron is not a valid five-field cron rule: "${cron}"`);
  const timezone = typeof schedule.timezone === "string" ? schedule.timezone : "";
  if (!timezone || !isValidTimeZone(timezone)) errors.push(`schedule.timezone is not a known time zone: "${timezone}"`);

  const timeoutMs = intInRange(raw.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  if (timeoutMs === null) errors.push(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  const maxRunsPerDay = intInRange(raw.maxRunsPerDay, DEFAULT_MAX_RUNS_PER_DAY, 1, MAX_RUNS_PER_DAY_LIMIT);
  if (maxRunsPerDay === null) errors.push(`maxRunsPerDay must be an integer between 1 and ${MAX_RUNS_PER_DAY_LIMIT}`);

  if (raw.catchUp !== undefined && raw.catchUp !== "once" && raw.catchUp !== "skip") errors.push('catchUp must be "once" or "skip"');
  if (raw.language != null && raw.language !== "uk" && raw.language !== "en") errors.push('language must be "uk" or "en"');
  if (raw.model !== undefined && (typeof raw.model !== "string" || !TOOL_NAME.test(raw.model.replace(/[.[\]]/g, "")))) {
    errors.push("model is not a model name");
  }

  // Write access is granted only by a click in the Marshal window, which does not exist yet.
  if (raw.writes !== undefined && raw.writes !== false) errors.push("writes cannot be enabled in a definition file");

  const mcpServers = raw.mcpServers === undefined ? [] : stringList(raw.mcpServers);
  if (!mcpServers) errors.push("mcpServers must be a list of names");
  const allowedTools = raw.allowedTools === undefined ? [] : stringList(raw.allowedTools);
  if (!allowedTools) errors.push("allowedTools must be a list of names");
  for (const tool of allowedTools ?? []) {
    if (!TOOL_NAME.test(tool)) {
      errors.push(`allowedTools: "${tool}" is not an exact tool name (no masks or arguments)`);
      continue;
    }
    if (!isReadOnlyTool(tool)) errors.push(`allowedTools: "${tool}" is not a read-only tool`);
    const server = mcpServerOf(tool);
    if (tool.startsWith("mcp__") && !server) errors.push(`allowedTools: "${tool}" is not of the form mcp__<server>__<tool>`);
    if (server && mcpServers && !mcpServers.includes(server)) errors.push(`allowedTools: "${tool}" needs "${server}" in mcpServers`);
  }

  if (errors.length > 0 || !id || !name || !prompt || !rule || timeoutMs === null || maxRunsPerDay === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    definition: {
      id,
      name,
      enabled: raw.enabled !== false,
      schedule: { cron, timezone },
      catchUp: (raw.catchUp as CatchUp | undefined) ?? (isDailyOrRarer(rule) ? "skip" : "once"),
      runAtStart: raw.runAtStart === true,
      timeoutMs,
      maxRunsPerDay,
      model: (raw.model as string | undefined) ?? DEFAULT_MODEL,
      prompt,
      allowedTools: allowedTools ?? [],
      mcpServers: mcpServers ?? [],
      writes: false,
      language: (raw.language as "uk" | "en" | null | undefined) ?? null
    }
  };
}

/** Identifies "the same task": memory written under another key is not carried over. */
export function memoryKey(definition: Pick<WorkflowDefinition, "prompt" | "allowedTools">): string {
  const tools = [...definition.allowedTools].sort();
  return createHash("sha256").update(JSON.stringify([definition.prompt, tools])).digest("hex");
}
