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

// AskUserQuestion and ExitPlanMode reach the same hook, but "allow" alone does
// not answer them: Claude Code turns an allow without updatedInput into a deny
// for tools whose dialog is the answer. Plan approval stays in the session.
export const QUESTION_TOOL = "AskUserQuestion";
const SESSION_ONLY_TOOLS = new Set(["ExitPlanMode"]);

export function isVoicePermission(request: PermissionRequest): boolean {
  return request.toolName !== QUESTION_TOOL && !SESSION_ONLY_TOOLS.has(request.toolName);
}

/** The one question of an AskUserQuestion call Marshal can ask aloud; null = leave it to the session. */
export type VoiceQuestion = { question: string; labels: string[] };

export function voiceQuestion(request: PermissionRequest): VoiceQuestion | null {
  if (request.toolName !== QUESTION_TOOL) return null;
  const questions = request.toolInput.questions;
  // Several questions, multi-select or a free-text box take longer to say than to click.
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const q = questions[0] as Record<string, unknown>;
  if (typeof q !== "object" || q === null || q.multiSelect === true) return null;
  if (q.kind !== undefined && q.kind !== "choice") return null;
  const question = str(q.question);
  const labels = Array.isArray(q.options) ? q.options.map((option) => str((option as Record<string, unknown>)?.label)) : [];
  if (!question || labels.length < 2 || labels.some((label) => !label)) return null;
  return { question, labels };
}

const MAX_SPOKEN_QUESTION_WORDS = 12;
const MAX_SPOKEN_LABEL_WORDS = 4;

function clip(text: string, maxWords: number): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  return words.length <= maxWords ? words.join(" ") : `${words.slice(0, maxWords).join(" ")}…`;
}

export function describeQuestion(name: string, q: VoiceQuestion, lang: UiLanguage): string {
  const options = q.labels.map((label, i) => `${i + 1}: ${clip(label, MAX_SPOKEN_LABEL_WORDS)}`).join(", ");
  return lang === "uk"
    ? `${name} питає: ${clip(q.question, MAX_SPOKEN_QUESTION_WORDS)} Варіанти — ${options}.`
    : `${name} asks: ${clip(q.question, MAX_SPOKEN_QUESTION_WORDS)} Options — ${options}.`;
}

const ORDINALS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["1", "один", "одна", "одну", "перший", "перша", "першу", "перше", "першого", "one", "first"]),
  new Set(["2", "два", "дві", "другий", "друга", "другу", "друге", "другого", "two", "second"]),
  new Set(["3", "три", "третій", "третя", "третю", "третє", "третього", "three", "third"]),
  new Set(["4", "чотири", "четвертий", "четверта", "четверту", "четверте", "четвертого", "four", "fourth"])
];
// Words that may surround the choice without changing it ("давай варіант два").
const MAX_EXTRA_WORDS = 4;

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s'’]/gu, " ").replace(/’/g, "'").split(/\s+/).filter(Boolean);
}

function indexOfRun(haystack: readonly string[], needle: readonly string[]): number {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((word, j) => haystack[i + j] === word)) return i;
  }
  return -1;
}

/**
 * Index of the option the owner named, by number or by label, or null.
 * Conservative: two different options named, a "no" outside a label, or a
 * long answer all mean no answer — the session keeps its own dialog.
 */
export function matchQuestionAnswer(text: string, labels: readonly string[]): number | null {
  let rest = words(text);
  if (rest.length === 0) return null;
  const chosen = new Set<number>();
  // Longest labels first, so "Blue sky" is not read as "Blue".
  const byLength = labels.map((label, i) => ({ i, run: words(label) })).sort((a, b) => b.run.length - a.run.length);
  for (const { i, run } of byLength) {
    const at = run.length > 0 ? indexOfRun(rest, run) : -1;
    if (at < 0) continue;
    chosen.add(i);
    rest = [...rest.slice(0, at), ...rest.slice(at + run.length)];
  }
  ORDINALS.slice(0, labels.length).forEach((set, i) => {
    if (rest.some((word) => set.has(word))) chosen.add(i);
  });
  rest = rest.filter((word) => !ORDINALS.some((set) => set.has(word)));
  if (chosen.size !== 1 || rest.some((word) => NO.has(word)) || rest.length > MAX_EXTRA_WORDS) return null;
  return [...chosen][0];
}

/** stdout of the hook: the same call, answered — Claude Code then shows no dialog. */
export function questionHookOutput(request: PermissionRequest, q: VoiceQuestion, index: number | null): string {
  if (index === null) return "";
  const updatedInput = { ...request.toolInput, answers: { [q.question]: q.labels[index] } };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput } } });
}
