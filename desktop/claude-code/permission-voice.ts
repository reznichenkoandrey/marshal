// Answering a Claude Code permission prompt by voice (#375). The
// PermissionRequest hook (Claude Code 2.1.322) waits for Marshal: it asks
// aloud, listens, and returns allow / deny — or nothing, and the session
// shows its usual prompt. Pure, so what counts as "yes" is pinned by tests:
// a misheard answer must never approve.

import path from "node:path";

import type { UiLanguage } from "../i18n/catalog.ts";

export type PermissionRequest = {
  sessionId: string;
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
};

export type PermissionDecision = "allow" | "deny";

export function parsePermissionRequest(raw: string): PermissionRequest | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const o = data as Record<string, unknown>;
  if (o.hook_event_name !== "PermissionRequest" || typeof o.session_id !== "string" || typeof o.tool_name !== "string") return null;
  const input = typeof o.tool_input === "object" && o.tool_input !== null ? (o.tool_input as Record<string, unknown>) : {};
  return { sessionId: o.session_id, cwd: typeof o.cwd === "string" ? o.cwd : "", toolName: o.tool_name, toolInput: input };
}

const MAX_COMMAND_WORDS = 6;
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** What the session wants, short enough to say aloud: no full commands, no paths. */
function describeAction(request: PermissionRequest, lang: UiLanguage): string {
  const uk = lang === "uk";
  const input = request.toolInput;
  if (request.toolName === "Bash") {
    const description = str(input.description);
    if (description) return uk ? `запустити: ${description}` : `run: ${description}`;
    const words = str(input.command).split(/\s+/).filter(Boolean).map((word) => (word.includes("/") ? path.basename(word) : word));
    const command = words.slice(0, MAX_COMMAND_WORDS).join(" ");
    return uk ? `запустити ${command}` : `run ${command}`;
  }
  if (FILE_TOOLS.has(request.toolName)) {
    const file = path.basename(str(input.file_path) || str(input.notebook_path));
    return uk ? `змінити ${file || "файл"}` : `edit ${file || "a file"}`;
  }
  if (request.toolName === "WebFetch") {
    let host = "";
    try {
      host = new URL(str(input.url)).hostname;
    } catch {
      host = "";
    }
    return uk ? `відкрити ${host || "сайт"}` : `open ${host || "a website"}`;
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(request.toolName);
  if (mcp) return uk ? `викликати ${mcp[2]} з ${mcp[1]}` : `use ${mcp[2]} from ${mcp[1]}`;
  return uk ? `використати ${request.toolName}` : `use ${request.toolName}`;
}

export function describePermission(name: string, request: PermissionRequest, lang: UiLanguage): string {
  const action = describeAction(request, lang);
  return lang === "uk" ? `${name} хоче ${action}. Дозволити?` : `${name} wants to ${action}. Allow?`;
}

const YES = new Set([
  "так", "да", "ага", "угу", "давай", "дозволяю", "дозволь", "дозволити", "можна", "ок", "окей", "роби", "запускай", "вперед", "звісно", "звичайно",
  "yes", "yeah", "yep", "sure", "ok", "okay", "allow", "approve", "go"
]);
const NO = new Set([
  "ні", "нє", "нет", "не", "ніт", "заборони", "забороняю", "відміни", "скасуй", "стоп", "зачекай", "чекай",
  "no", "nope", "deny", "cancel", "stop", "don't", "dont", "wait"
]);
const MAX_ANSWER_WORDS = 5;

/** Strict: any "no" word denies, a short answer with a "yes" word allows, anything else is no decision. */
export function classifyPermissionAnswer(text: string): PermissionDecision | null {
  const words = text.toLowerCase().replace(/[^\p{L}\s'’]/gu, " ").replace(/’/g, "'").split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  if (words.some((word) => NO.has(word))) return "deny";
  if (words.length <= MAX_ANSWER_WORDS && words.some((word) => YES.has(word))) return "allow";
  return null;
}

/** stdout of the hook; empty = Claude Code shows its own prompt. */
export function permissionHookOutput(decision: PermissionDecision | null): string {
  if (!decision) return "";
  const body = decision === "allow"
    ? { behavior: "allow" }
    : { behavior: "deny", message: "The owner declined this by voice." };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: body } });
}
