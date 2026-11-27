// Answering a Claude Code permission prompt by voice (#375). The
// PermissionRequest hook (Claude Code 2.1.322) waits for Marshal: it asks
// aloud, listens, and returns allow / deny — or nothing, and the session
// shows its usual prompt. Pure, so what counts as "yes" is pinned by tests:
// a misheard answer must never approve.

import path from "node:path";

import { speakableProject } from "../assistant/waiting-speech.ts";
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

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_TITLE_WORDS = 8;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clip(text: string, maxWords: number): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  return words.length <= maxWords ? words.join(" ") : `${words.slice(0, maxWords).join(" ")}…`;
}

/** Who is asking, as the owner hears it away from the screen (#544). */
export type Asker = { project: string; title: string | null };

/**
 * The session's name worth saying aloud: a human title (Claude desktop names
 * sessions in words), else the Feature line of its cached dossier, else none.
 * A slug like `cpap-ed` or `fix_auth_flow` is not said: by ear it is noise.
 */
export function spokenSessionTitle(name: string | null, dossier: string | null): string | null {
  if (name && /\s/.test(name.trim())) return clip(name, MAX_TITLE_WORDS);
  const feature = /^Feature:\s*(.+)$/im.exec(dossier ?? "")?.[1] ?? "";
  // Branches and paths are not words.
  const words = feature.split(/\s+/).filter((word) => word && !/[/_\\]/.test(word));
  return words.length > 0 ? clip(words.join(" "), MAX_TITLE_WORDS) : null;
}

function who(asker: Asker, lang: UiLanguage): string {
  const project = speakableProject(asker.project);
  if (lang === "uk") return `У проєкті ${project} сесія${asker.title ? ` «${asker.title}»` : ""}`;
  return `In ${project}, ${asker.title ? `session “${asker.title}”` : "a session"}`;
}

type Phrase = [uk: string, en: string];

// First match wins; a command the owner would worry about is named plainly.
const COMMANDS: ReadonlyArray<[RegExp, Phrase]> = [
  [/^sudo\b/, ["виконати команду з правами адміністратора", "run a command as administrator"]],
  [/^git push\b/, ["запушити зміни", "push changes"]],
  [/^git commit\b/, ["зробити коміт", "make a commit"]],
  [/^git (reset|clean|restore)\b/, ["скинути зміни в git", "discard changes in git"]],
  [/^git (checkout|switch)\b/, ["перемкнути гілку", "switch branches"]],
  [/^git (merge|rebase)\b/, ["злити гілки", "merge branches"]],
  [/^git branch -[dD]\b/, ["видалити гілку", "delete a branch"]],
  [/^gh pr merge\b/, ["змерджити PR", "merge the PR"]],
  [/^gh pr create\b/, ["відкрити PR", "open a PR"]],
  [/^gh issue create\b/, ["створити issue на GitHub", "create a GitHub issue"]],
  [/^gh\b/, ["звернутися до GitHub", "use GitHub"]],
  [/^((npm|pnpm|yarn|bun)( run)? test|(npx )?(vitest|jest|pytest)|go test|cargo test)\b/, ["запустити тести", "run the tests"]],
  [/^((npm|pnpm|yarn|bun) (i|install|add|ci)|pip3? install|brew install|composer (install|require|update)|uv (pip|add|sync))\b/, ["встановити залежності", "install dependencies"]],
  [/^(npm|pnpm|yarn|bun) run build\b/, ["зібрати проєкт", "build the project"]],
  [/^(npm|pnpm|yarn|bun) run\b/, ["запустити скрипт проєкту", "run a project script"]],
  [/^(rm|rmdir|trash|unlink)\b/, ["видалити файли", "delete files"]],
  [/^mv\b/, ["перемістити файли", "move files"]],
  [/^cp\b/, ["скопіювати файли", "copy files"]],
  [/^mkdir\b/, ["створити теку", "create a folder"]],
  [/^(curl|wget|http|xh)\b/, ["звернутися в інтернет", "make a web request"]],
  [/^(docker|docker-compose)\b/, ["запустити docker", "run docker"]],
  [/^(kill|pkill|killall)\b/, ["зупинити процес", "stop a process"]],
  [/^osascript\b/, ["керувати іншою програмою", "control another app"]],
  [/^open\b/, ["відкрити програму чи файл", "open an app or a file"]]
];

/** The command parts that do something: `cd x &&` and `FOO=1` are not the action. */
function commandParts(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim().replace(/^(\w+=\S*\s+)+/, ""))
    .map((part) => part.replace(/^(\S*\/)(\S+)/, "$2"))
    .filter((part) => part !== "" && !/^cd\b/.test(part));
}

function describeCommand(input: Record<string, unknown>, uk: boolean): string {
  const parts = commandParts(str(input.command));
  for (const part of parts) {
    const match = COMMANDS.find(([pattern]) => pattern.test(part));
    if (match) return match[1][uk ? 0 : 1];
  }
  const description = str(input.description);
  if (description) return uk ? `виконати команду «${clip(description, MAX_TITLE_WORDS)}»` : `run “${clip(description, MAX_TITLE_WORDS)}”`;
  const head = parts[0]?.split(/\s+/)[0] ?? "";
  return uk ? `виконати команду ${head}`.trim() : `run ${head || "a command"}`;
}

const MCP_VERBS: ReadonlyArray<[ReadonlySet<string>, Phrase]> = [
  [new Set(["get", "list", "read", "search", "find", "fetch", "query", "view", "describe", "show", "whoami", "status"]), ["подивитися", "look at"]],
  [new Set(["create", "add", "new", "insert", "upload", "generate", "make"]), ["створити", "create"]],
  [new Set(["update", "edit", "set", "modify", "rename", "move", "replace", "write", "patch", "merge"]), ["змінити", "change"]],
  [new Set(["delete", "remove", "trash", "drop", "clear", "archive", "unlink"]), ["видалити", "delete"]],
  [new Set(["send", "post", "reply", "forward", "publish", "comment", "share"]), ["надіслати", "send"]],
  [new Set(["run", "execute", "start", "trigger", "stop"]), ["запустити", "run"]],
  [new Set(["use", "call", "invoke"]), ["скористатися", "use"]]
];
// Clicking and typing in a browser or an app: what it controls matters, not the gesture.
const CONTROL_VERBS = new Set(["click", "type", "press", "navigate", "fill", "hover", "drag", "drop", "scroll", "select", "screenshot", "key", "tap", "open", "focus", "batch"]);

function describeMcp(server: string, tool: string, uk: boolean): string {
  // plugin_<plugin>_<server>: the server is what the owner knows; UUID ids are unknowable.
  const bare = server.startsWith("plugin_") ? server.split("_").pop() ?? server : server;
  const place = /^[0-9a-f]{8}-/i.test(bare) ? "" : speakableProject(bare);
  const words = speakableProject(tool).toLowerCase().split(" ").filter(Boolean);
  if (words.some((word) => CONTROL_VERBS.has(word))) {
    return uk ? `керувати ${place || "програмою через конектор"}` : `control ${place || "an app through a connector"}`;
  }
  const at = words.findIndex((word) => MCP_VERBS.some(([set]) => set.has(word)));
  const verb = at >= 0 ? MCP_VERBS.find(([set]) => set.has(words[at]))![1] : (["скористатися", "use"] as Phrase);
  const object = (at >= 0 ? words.filter((_, i) => i !== at) : words).join(" ");
  const via = place && place.toLowerCase() !== object ? (uk ? ` у ${place}` : ` in ${place}`) : "";
  return `${verb[uk ? 0 : 1]}${object ? ` ${object}` : ""}${via}`.trim();
}

/** What the session wants, in plain words: no full commands, no paths, no tool ids. */
function describeAction(request: PermissionRequest, lang: UiLanguage): string {
  const uk = lang === "uk";
  const input = request.toolInput;
  if (request.toolName === "Bash") return describeCommand(input, uk);
  if (FILE_TOOLS.has(request.toolName)) {
    const file = path.basename(str(input.file_path) || str(input.notebook_path));
    return uk ? `змінити ${file ? `файл ${file}` : "файл"}` : `edit ${file || "a file"}`;
  }
  if (request.toolName === "WebFetch") {
    let host = "";
    try {
      host = new URL(str(input.url)).hostname;
    } catch {
      host = "";
    }
    return uk ? `відкрити ${host ? `сайт ${host}` : "сайт"}` : `open ${host || "a website"}`;
  }
  if (request.toolName === "WebSearch") return uk ? "пошукати в інтернеті" : "search the web";
  const mcp = /^mcp__(.+?)__(.+)$/.exec(request.toolName);
  if (mcp) return describeMcp(mcp[1], mcp[2], uk);
  return uk ? `скористатися ${request.toolName}` : `use ${request.toolName}`;
}

export function describePermission(asker: Asker, request: PermissionRequest, lang: UiLanguage): string {
  const action = describeAction(request, lang);
  return lang === "uk" ? `${who(asker, lang)} просить дозвіл ${action}. Дозволити?` : `${who(asker, lang)} asks permission to ${action}. Allow?`;
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
  // A long answer is the owner talking about something else: «…задачу, яку ми не закінчили» declined a prompt (live check 2026-11-26).
  if (words.length > MAX_ANSWER_WORDS) return null;
  if (words.some((word) => NO.has(word))) return "deny";
  if (words.some((word) => YES.has(word))) return "allow";
  return null;
}

/** An answer this long is not a reply to the prompt but a command for Marshal. */
export function isLongAnswer(text: string): boolean {
  return text.trim().split(/\s+/u).filter(Boolean).length > MAX_ANSWER_WORDS;
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

/** One question of an AskUserQuestion call, as Marshal says it aloud. */
export type VoiceQuestion = { question: string; labels: string[]; multiSelect: boolean };

// More questions take longer to hear than to click through; past this the session asks.
const MAX_VOICE_QUESTIONS = 3;

/**
 * The questions of an AskUserQuestion call Marshal can ask aloud, in order;
 * null = leave the whole call to the session. Free-text boxes are not spoken:
 * there is no list to name an answer from.
 */
export function voiceQuestions(request: PermissionRequest): VoiceQuestion[] | null {
  if (request.toolName !== QUESTION_TOOL) return null;
  const questions = request.toolInput.questions;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > MAX_VOICE_QUESTIONS) return null;
  const result: VoiceQuestion[] = [];
  for (const raw of questions) {
    const q = raw as Record<string, unknown>;
    if (typeof q !== "object" || q === null) return null;
    if (q.kind !== undefined && q.kind !== "choice") return null;
    const question = str(q.question);
    const labels = Array.isArray(q.options) ? q.options.map((option) => str((option as Record<string, unknown>)?.label)) : [];
    if (!question || labels.length < 2 || labels.some((label) => !label)) return null;
    result.push({ question, labels, multiSelect: q.multiSelect === true });
  }
  return result;
}

const MAX_SPOKEN_QUESTION_WORDS = 12;
const MAX_SPOKEN_LABEL_WORDS = 4;

export function describeQuestion(asker: Asker, q: VoiceQuestion, lang: UiLanguage): string {
  const options = q.labels.map((label, i) => `${i + 1}: ${clip(label, MAX_SPOKEN_LABEL_WORDS)}`).join(", ");
  const uk = lang === "uk";
  const hint = q.multiSelect ? (uk ? " Можна кілька." : " Several allowed.") : "";
  return uk
    ? `${who(asker, lang)} питає: ${clip(q.question, MAX_SPOKEN_QUESTION_WORDS)} Варіанти — ${options}.${hint}`
    : `${who(asker, lang)} asks: ${clip(q.question, MAX_SPOKEN_QUESTION_WORDS)} Options — ${options}.${hint}`;
}

/** A turn that ended with a question (#547); "" = too long to say, so only that the session asks. */
export function describeClosingQuestion(asker: Asker, question: string, lang: UiLanguage): string {
  if (lang === "uk") return question ? `${who(asker, lang)} питає: ${question}` : `${who(asker, lang)} питає тебе.`;
  return question ? `${who(asker, lang)} asks: ${question}` : `${who(asker, lang)} has a question for you.`;
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

// Joiners that may sit between two named options ("перший і третій").
const JOINERS = new Set(["і", "та", "й", "and", "plus"]);
// "All of them" is never guessed from a partial list: the session asks.
const ALL_OPTIONS = new Set(["усі", "всі", "всіх", "обидва", "обидві", "обоє", "all", "both", "every"]);

/**
 * Indexes of the options the owner named, by number or label, in label order.
 * Conservative: a "no" outside a label, "all" or a long answer name nothing,
 * so the session keeps its own dialog.
 */
function namedOptions(text: string, labels: readonly string[]): number[] {
  let rest = words(text);
  if (rest.length === 0 || rest.some((word) => ALL_OPTIONS.has(word))) return [];
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
  rest = rest.filter((word) => !ORDINALS.some((set) => set.has(word)) && !JOINERS.has(word));
  if (rest.some((word) => NO.has(word)) || rest.length > MAX_EXTRA_WORDS) return [];
  return [...chosen].sort((a, b) => a - b);
}

/** Index of the single option the owner named, or null. Two options named = null. */
export function matchQuestionAnswer(text: string, labels: readonly string[]): number | null {
  const chosen = namedOptions(text, labels);
  return chosen.length === 1 ? chosen[0] : null;
}

/** Indexes of every option the owner named for a multi-select question, or null. */
export function matchMultiAnswer(text: string, labels: readonly string[]): number[] | null {
  const chosen = namedOptions(text, labels);
  return chosen.length > 0 ? chosen : null;
}

/** Chosen option indexes for one question, or null when the answer is unclear. */
export function matchVoiceAnswer(text: string, q: VoiceQuestion): number[] | null {
  if (q.multiSelect) return matchMultiAnswer(text, q.labels);
  const index = matchQuestionAnswer(text, q.labels);
  return index === null ? null : [index];
}

/** One answer per question: indexes from matchVoiceAnswer, null = unclear. */
export function answerChoices(q: VoiceQuestion, picks: number[] | null): string | null {
  if (!picks || picks.length === 0) return null;
  if (!q.multiSelect) return picks.length === 1 ? q.labels[picks[0]] : null;
  return picks.map((index) => q.labels[index]).join(", ");
}

/** stdout of the hook: the same call, answered — Claude Code then shows no dialog. Any unanswered question = "" (the session asks). */
export function questionHookOutput(request: PermissionRequest, questions: readonly VoiceQuestion[], picks: ReadonlyArray<number[] | null>): string {
  if (picks.length !== questions.length) return "";
  const values = questions.map((q, i) => answerChoices(q, picks[i]));
  if (values.some((value) => value === null)) return "";
  const answers = Object.fromEntries(questions.map((q, i) => [q.question, values[i] as string]));
  const updatedInput = { ...request.toolInput, answers };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput } } });
}

// Elicitation (MCP server asks the owner): only a pure confirmation, with no
// fields to fill, is spoken. Anything with a form stays in the session.
export type ElicitationRequest = { sessionId: string; cwd: string; server: string; message: string };

export function parseElicitationRequest(raw: string): ElicitationRequest | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const o = data as Record<string, unknown>;
  if (o.hook_event_name !== "Elicitation" || typeof o.session_id !== "string") return null;
  const schema = typeof o.requested_schema === "object" && o.requested_schema !== null ? (o.requested_schema as Record<string, unknown>) : {};
  const properties = typeof schema.properties === "object" && schema.properties !== null ? (schema.properties as Record<string, unknown>) : {};
  const message = str(o.message);
  if (Object.keys(properties).length > 0 || !message) return null;
  return { sessionId: o.session_id, cwd: typeof o.cwd === "string" ? o.cwd : "", server: str(o.mcp_server_name), message };
}

export function describeElicitation(asker: Asker, request: ElicitationRequest, lang: UiLanguage): string {
  const message = clip(request.message, MAX_SPOKEN_QUESTION_WORDS);
  return lang === "uk"
    ? `${who(asker, lang)} просить підтвердити: ${message} Дозволити?`
    : `${who(asker, lang)} asks to confirm: ${message} Allow?`;
}

/** stdout of the hook: accept on a yes, decline on a no, nothing if unclear. */
export function elicitationHookOutput(decision: PermissionDecision | null): string {
  if (!decision) return "";
  const action = decision === "allow" ? "accept" : "decline";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "Elicitation", action } });
}
