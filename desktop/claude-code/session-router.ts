// Decides which Claude Code session a dictated command is for (#264). Pure
// apart from the optional context router, so every rule here is unit-tested:
// spoken names come out of whisper in Ukrainian, English or a mix of both
// («фіча 1494», "feature 1494", "Васю"), so names are compared after both
// sides are transliterated to Latin and inflection is tolerated.

import path from "node:path";

import type { ClaudeSession } from "./registry.ts";

// Contract with #286 (context routing). Defined here verbatim so both
// branches merge without a shared file.
export type ContextRoute =
  | { kind: "session"; sessionId: string }
  | { kind: "unsure"; candidates: string[] }
  | { kind: "off" };
export interface ContextRouter {
  route(command: string, sessions: readonly ClaudeSession[]): Promise<ContextRoute>;
}

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y",
  і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s",
  т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu",
  я: "ia", ы: "y", э: "e", ё: "io", ъ: "", "'": "", "’": "", "ʼ": ""
};

export function transliterate(text: string): string {
  return Array.from(text.toLowerCase(), (ch) => TRANSLIT[ch] ?? ch).join("");
}

// Dev words people say in Ukrainian but name branches with in English.
// Transliteration alone turns «фіча» into "ficha", never "feature".
const LOANWORDS: ReadonlyArray<readonly [string, string]> = [
  ["фічер", "feature"],
  ["фіч", "feature"],
  ["хотфікс", "hotfix"],
  ["фікс", "fix"],
  ["баг", "bug"],
  ["реліз", "release"],
  ["рефактор", "refactor"],
  ["тест", "test"],
  ["деплой", "deploy"],
  ["бранч", "branch"],
  ["гілк", "branch"]
];
const NOUN_ENDINGS = new Set(["", "а", "я", "и", "і", "у", "ю", "е", "о", "ом", "ем", "ою", "ею", "ів", "ам", "ами", "ах", "ці"]);

function translateLoanword(word: string): string | null {
  for (const [stem, latin] of LOANWORDS) {
    if (word.startsWith(stem) && NOUN_ENDINGS.has(word.slice(stem.length))) return latin;
  }
  return null;
}

type SpokenToken = { norm: string; end: number };

// "feature1494" and "feature 1494" must compare equal, so letters and digits
// are always separate tokens.
function splitAlnum(word: string): string[] {
  return word.match(/\p{N}+|\p{L}+/gu) ?? [];
}

function tokenizeSpoken(text: string): SpokenToken[] {
  const tokens: SpokenToken[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}'’ʼ]+/gu)) {
    const word = match[0].toLowerCase();
    const end = (match.index ?? 0) + match[0].length;
    const latin = translateLoanword(word) ?? transliterate(word);
    for (const norm of splitAlnum(latin)) tokens.push({ norm, end });
  }
  return tokens;
}

// whisper writes "1494" as "1,494" or "1 494".
function joinDigitGroups(text: string): string {
  let prev = "";
  let next = text;
  while (next !== prev) {
    prev = next;
    next = next.replace(/(\d)[ ,. ](\d{3})(?!\d)/gu, "$1$2");
  }
  return next;
}

/**
 * Inflection- and spelling-tolerant word comparison on transliterated tokens:
 * «Вася», «Васі», «Васю», "Vasya" all share a stem. Numbers compare exactly.
 */
export function tokensMatch(spoken: string, key: string): boolean {
  if (spoken === key) return true;
  if (/\d/u.test(spoken) || /\d/u.test(key)) return false;
  let prefix = 0;
  while (prefix < spoken.length && prefix < key.length && spoken[prefix] === key[prefix]) prefix += 1;
  return prefix >= 3 && key.length - prefix <= 2 && spoken.length - prefix <= 3;
}

/**
 * Names a session answers to: its /rename name, its folder, and both without
 * the random suffix Claude worktrees get (`dictate-to-session-7fa531`).
 */
export function sessionAliases(session: Pick<ClaudeSession, "name" | "cwd">): string[] {
  const raw = [session.name, path.basename(session.cwd)];
  const withoutSuffix = raw.map((alias) => alias.replace(/[-_][0-9a-f]{6}$/u, ""));
  return [...new Set([...raw, ...withoutSuffix].filter((alias) => alias.trim() !== ""))];
}

const FILLER_KEYS = ["session", "sesiia"];

export type NameMatch = { sessions: ClaudeSession[]; rest: string };

/**
 * The session(s) whose name the transcript starts with, and the command after
 * it. The longest matching alias wins; a tie between sessions is ambiguous and
 * returns all of them.
 */
export function matchSessionPrefix(transcript: string, sessions: readonly ClaudeSession[]): NameMatch | null {
  const text = joinDigitGroups(transcript);
  const spoken = tokenizeSpoken(text);
  let start = 0;
  while (start < spoken.length && FILLER_KEYS.some((key) => tokensMatch(spoken[start].norm, key))) start += 1;

  let best = 0;
  let bestEnd = 0;
  let matched: ClaudeSession[] = [];
  for (const session of sessions) {
    for (const alias of sessionAliases(session)) {
      const keys = splitAlnum(transliterate(alias));
      if (keys.length === 0 || start + keys.length > spoken.length) continue;
      if (!keys.every((key, i) => tokensMatch(spoken[start + i].norm, key))) continue;
      if (keys.length > best) {
        best = keys.length;
        bestEnd = spoken[start + keys.length - 1].end;
        matched = [session];
      } else if (keys.length === best && !matched.includes(session)) {
        matched.push(session);
      }
    }
  }
  if (matched.length === 0) return null;
  return { sessions: matched, rest: text.slice(bestEnd).replace(/^[\s,.:;!?—–-]+/u, "").trim() };
}

function cleanPhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’ʼ ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const CANCEL_PHRASES = ["скасуй", "скасувати", "скасовую", "відміна", "відмінити", "відміни", "забудь", "cancel", "never mind", "nevermind"];

/** A command that ends in «скасуй» / "cancel" is dropped, not sent. */
export function isCancelled(transcript: string): boolean {
  const phrase = cleanPhrase(transcript);
  return CANCEL_PHRASES.some((cancel) => phrase === cancel || phrase.endsWith(` ${cancel}`));
}

export type ShortAnswer = { kind: "yes" } | { kind: "no" } | { kind: "option"; n: number };

const YES = new Set(["так", "да", "ага", "давай", "роби", "зроби", "підтверджую", "yes", "yeah", "yep", "ok", "okay", "окей", "sure", "do it", "go", "go ahead", "approve"]);
const NO = new Set(["ні", "нет", "не треба", "відхили", "no", "nope", "reject", "deny"]);
const OPTION_WORDS = new Set(["варіант", "варіанту", "опція", "опцію", "пункт", "номер", "option", "number", "the", "choose", "вибираю", "обираю"]);
const NUMBERS: Record<string, number> = {
  один: 1, одна: 1, перший: 1, перша: 1, першу: 1, one: 1, first: 1,
  два: 2, дві: 2, другий: 2, друга: 2, другу: 2, two: 2, second: 2,
  три: 3, третій: 3, третя: 3, третю: 3, three: 3, third: 3,
  чотири: 4, четвертий: 4, четверта: 4, четверту: 4, four: 4, fourth: 4,
  "п'ять": 5, "пʼять": 5, "п’ять": 5, пять: 5, "п'ятий": 5, "пʼятий": 5, five: 5, fifth: 5
};

/** «так», "option two", «другий варіант», "3" — a reply to a waiting prompt. */
export function parseShortAnswer(command: string): ShortAnswer | null {
  const phrase = cleanPhrase(command);
  if (phrase === "" || phrase.split(" ").length > 4) return null;
  if (YES.has(phrase)) return { kind: "yes" };
  if (NO.has(phrase)) return { kind: "no" };
  const rest = phrase.split(" ").filter((word) => !OPTION_WORDS.has(word));
  if (rest.length !== 1) return null;
  const n = /^[1-9]$/u.test(rest[0]) ? Number(rest[0]) : NUMBERS[rest[0]];
  return n ? { kind: "option", n } : null;
}

export type Delivery =
  | { kind: "text"; text: string }
  | { kind: "key"; key: string }
  | { kind: "blocked"; reason: string };

function isPermissionPrompt(session: Pick<ClaudeSession, "status" | "waitingFor">): boolean {
  return session.status === "waiting" && /permission/iu.test(session.waitingFor ?? "");
}

/**
 * What to type into the session. A permission prompt is a menu where Return
 * picks the highlighted "Yes", so free text followed by Return would approve
 * something nobody asked to approve: only answers go there, as single keys.
 */
export function planDelivery(command: string, session: Pick<ClaudeSession, "status" | "waitingFor">): Delivery {
  const answer = parseShortAnswer(command);
  if (isPermissionPrompt(session)) {
    if (!answer) return { kind: "blocked", reason: "is waiting for a permission answer — say yes, no or an option number" };
    if (answer.kind === "yes") return { kind: "key", key: "1" };
    if (answer.kind === "no") return { kind: "key", key: "escape" };
    return { kind: "key", key: String(answer.n) };
  }
  if (session.status === "waiting" && answer?.kind === "option") return { kind: "key", key: String(answer.n) };
  return { kind: "text", text: command };
}

export type RouteDecision =
  | { kind: "cancelled" }
  | { kind: "no-sessions" }
  | { kind: "empty"; session: ClaudeSession }
  | { kind: "send"; session: ClaudeSession; command: string }
  | { kind: "pick"; candidates: ClaudeSession[]; command: string };

function toDecision(candidates: ClaudeSession[], command: string): RouteDecision {
  return candidates.length === 1
    ? { kind: "send", session: candidates[0], command }
    : { kind: "pick", candidates, command };
}

export class SessionCommandRouter {
  private lastSessionId: string | null = null;

  constructor(private readonly contextRouter?: ContextRouter) {}

  /** Only a command that actually reached a session moves the default. */
  remember(sessionId: string): void {
    this.lastSessionId = sessionId;
  }

  async route(transcript: string, sessions: readonly ClaudeSession[]): Promise<RouteDecision> {
    const text = transcript.trim();
    if (text === "" || isCancelled(text)) return { kind: "cancelled" };
    if (sessions.length === 0) return { kind: "no-sessions" };

    const named = matchSessionPrefix(text, sessions);
    if (named) {
      if (named.rest === "" && named.sessions.length === 1) return { kind: "empty", session: named.sessions[0] };
      return toDecision(named.sessions, named.rest);
    }

    const waiting = sessions.filter((session) => session.status === "waiting");
    if (waiting.length > 0) return toDecision(waiting, text);

    const routed = await this.routeByContext(text, sessions);
    if (routed) return routed;

    const last = sessions.find((session) => session.sessionId === this.lastSessionId);
    return toDecision(last ? [last] : [...sessions], text);
  }

  private async routeByContext(command: string, sessions: readonly ClaudeSession[]): Promise<RouteDecision | null> {
    if (!this.contextRouter) return null;
    let route: ContextRoute;
    try {
      route = await this.contextRouter.route(command, sessions);
    } catch (err) {
      console.warn("[claude-dictation] context router failed:", err instanceof Error ? err.message : err);
      return null;
    }
    if (route.kind === "session") {
      const session = sessions.find((candidate) => candidate.sessionId === route.sessionId);
      return session ? { kind: "send", session, command } : null;
    }
    if (route.kind === "unsure") {
      const candidates = sessions.filter((session) => route.candidates.includes(session.sessionId));
      return candidates.length > 0 ? toDecision(candidates, command) : null;
    }
    return null;
  }
}
