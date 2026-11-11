export type SpeechLang = "uk" | "en";

export type SystemVoice = {
  /** Exactly as `say -v '?'` prints it; `say -v <name>` accepts it verbatim. */
  name: string;
  /** e.g. `uk_UA`, `en_US`. */
  locale: string;
};

export type SpeechItem = {
  text: string;
  lang: SpeechLang;
  /** Items sharing a key replace each other while unspoken (one session = one key). */
  key?: string;
};

export const DEFAULT_SPEECH_RATE = 190;
export const MIN_SPEECH_RATE = 90;
export const MAX_SPEECH_RATE = 360;
export const MAX_QUEUED_ITEMS = 10;

export const NO_UK_VOICE_MESSAGE =
  "No Ukrainian voice is installed. Add one in System Settings → Accessibility → " +
  "Spoken Content → System Voice → Manage Voices → Ukrainian (e.g. Lesya).";
export const NO_EN_VOICE_MESSAGE =
  "No English voice is installed. Add one in System Settings → Accessibility → Spoken Content → Manage Voices.";

// Novelty voices (Bells, Zarvox, …) also carry en_US, so "first English voice"
// alone would pick one of them on a stock Mac.
const PREFERRED_EN_VOICES = ["Samantha", "Alex", "Daniel", "Karen", "Moira", "Tessa"];

const VOICE_LINE = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/;

/** Parses `say -v '?'`. Display names are localized, so nothing here assumes a name. */
export function parseSayVoices(output: string): SystemVoice[] {
  const seen = new Set<string>();
  const voices: SystemVoice[] = [];
  for (const line of output.split("\n")) {
    const match = VOICE_LINE.exec(line);
    if (!match) continue;
    const voice = { name: match[1].trim(), locale: match[2] };
    // Compact and enhanced variants of one voice print as identical lines.
    const id = `${voice.name}\u0000${voice.locale}`;
    if (seen.has(id)) continue;
    seen.add(id);
    voices.push(voice);
  }
  return voices;
}

/** "Lesya (Українська (Україна))" → "Lesya". */
export function voiceBaseName(name: string): string {
  const paren = name.indexOf(" (");
  return paren === -1 ? name : name.slice(0, paren);
}

export function voicesForLang(voices: readonly SystemVoice[], lang: SpeechLang): SystemVoice[] {
  return voices.filter((voice) => voice.locale.toLowerCase().startsWith(`${lang}_`));
}

/**
 * The voice for `lang`: the Settings choice when it is still installed, then a
 * known-good default, then whatever the system has. `null` = nothing installed
 * for that language; speaking Ukrainian with an English voice is gibberish, so
 * callers report it instead of falling back across languages.
 */
export function pickVoice(
  voices: readonly SystemVoice[],
  lang: SpeechLang,
  preferred = ""
): SystemVoice | null {
  const candidates = voicesForLang(voices, lang);
  if (candidates.length === 0) return null;
  const wanted = preferred.trim();
  if (wanted) {
    const exact = candidates.find((voice) => voice.name === wanted);
    if (exact) return exact;
  }
  if (lang === "en") {
    for (const name of PREFERRED_EN_VOICES) {
      const match = candidates.find((voice) => voiceBaseName(voice.name) === name && voice.locale === "en_US")
        ?? candidates.find((voice) => voiceBaseName(voice.name) === name);
      if (match) return match;
    }
  }
  return candidates[0];
}

const CYRILLIC_WORD = /\p{Script=Cyrillic}/u;
const LATIN_WORD = /\p{Script=Latin}/u;
// Identifiers spoken inside a Ukrainian sentence (`rate limit`, file names,
// camelCase) must not outvote it, so code spans, URLs and anything shaped like
// a path or identifier are dropped before counting.
const CODE_SPAN = /`[^`]*`/g;
const URL_LIKE = /\b\w+:\/\/\S+/g;
const IDENTIFIER_LIKE = /[\\/._#@:=<>{}()[\]]|\d|\p{Ll}\p{Lu}/u;
const EDGE_PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

/**
 * Language of the sentence, not of its terms: Ukrainian wins once Cyrillic
 * words are at least a third of the words, which keeps a Ukrainian summary
 * full of English terms Ukrainian.
 */
export function detectSpeechLang(text: string, fallback: SpeechLang = "uk"): SpeechLang {
  const words = text.replace(CODE_SPAN, " ").replace(URL_LIKE, " ").split(/\s+/);
  let cyrillic = 0;
  let latin = 0;
  for (const raw of words) {
    const word = raw.replace(EDGE_PUNCTUATION, "");
    if (!word || IDENTIFIER_LIKE.test(word)) continue;
    if (CYRILLIC_WORD.test(word)) cyrillic++;
    else if (LATIN_WORD.test(word)) latin++;
  }
  if (cyrillic === 0 && latin === 0) return fallback;
  return cyrillic * 2 >= latin ? "uk" : "en";
}

// How the team says English terms inside a Ukrainian sentence. Ukrainian
// voices read Latin as letter soup ("PR" comes out as "ПР"), and Holos cannot
// pronounce Latin at all. Abbreviations read as words belong here; anything
// spelled letter by letter is handled by LETTER_NAMES below.
export const SPOKEN_TERMS: Readonly<Record<string, string>> = {
  "pull request": "пул реквест",
  "merge request": "мердж реквест",
  "rate limit": "рейт ліміт",
  "Claude Code": "клод код",
  JSON: "джейсон",
  YAML: "ямл",
  GIF: "гіф",
  RAM: "рам",
  SQL: "сіквел",
  OAuth: "оу-ауз",
  macOS: "мак-оу-ес",
  iOS: "ай-оу-ес",
  iPhone: "айфон",
  "Wi-Fi": "вай-фай",
  GitHub: "гітхаб",
  GitLab: "гітлаб",
  Git: "гіт",
  npm: "ен-пі-ем",
  Claude: "клод",
  Codex: "кодекс",
  Groq: "грок",
  Whisper: "віспер",
  Holos: "голос",
  Marshal: "маршал",
  Figma: "фігма",
  Slack: "слек",
  Zoom: "зум",
  Meet: "міт",
  Telegram: "телеграм",
  Chrome: "хром",
  Electron: "електрон",
  Docker: "докер",
  Node: "ноуд",
  React: "ріакт",
  TypeScript: "тайпскрипт",
  JavaScript: "джаваскрипт",
  Python: "пайтон",
  Magento: "маджента",
  Hyva: "хайва",
  deploy: "деплой",
  commit: "коміт",
  merge: "мердж",
  push: "пуш",
  pull: "пул",
  branch: "бранч",
  release: "реліз",
  build: "білд",
  issue: "ішʼю",
  review: "рев'ю",
  bug: "баг",
  fix: "фікс",
  test: "тест",
  tests: "тести",
  worktree: "ворктрі",
  backend: "бекенд",
  frontend: "фронтенд",
  hook: "хук",
  hooks: "хуки",
  prompt: "промпт",
  summary: "саммарі",
  dashboard: "дешборд",
  cache: "кеш",
  token: "токен",
  tokens: "токени"
};

const LETTER_NAMES: Readonly<Record<string, string>> = {
  A: "ей", B: "бі", C: "сі", D: "ді", E: "і", F: "еф", G: "джі", H: "ейч", I: "ай",
  J: "джей", K: "кей", L: "ел", M: "ем", N: "ен", O: "оу", P: "пі", Q: "кʼю", R: "ар",
  S: "ес", T: "ті", U: "ю", V: "ві", W: "дабл-ю", X: "екс", Y: "вай", Z: "зет"
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Longest first, so "pull request" wins over "pull". `\b` is ASCII-only (#147).
const SPOKEN_TERM_PATTERN = new RegExp(
  `(?<![\\p{L}\\d])(?:${Object.keys(SPOKEN_TERMS)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")})(?![\\p{L}\\d])`,
  "giu"
);
const SPOKEN_TERM_LOOKUP = new Map(Object.entries(SPOKEN_TERMS).map(([term, spoken]) => [term.toLowerCase(), spoken]));
const ABBREVIATION = /(?<![\p{L}\d])[A-Z]{2,6}(?![\p{L}\d])/gu;

/** Rewrites English terms of a Ukrainian phrase the way the team says them (#371). */
export function pronounceForUkrainian(text: string): string {
  return text
    .replace(SPOKEN_TERM_PATTERN, (match) => SPOKEN_TERM_LOOKUP.get(match.toLowerCase()) ?? match)
    .replace(ABBREVIATION, (match) => [...match].map((letter) => LETTER_NAMES[letter]).join("-"));
}

/** `macos` = `say`; `piper` (#325) and `holos` (#333) = downloaded local neural Ukrainian voices. */
export type SpeechEngine = "macos" | "piper" | "holos";

export function normalizeSpeechEngine(value: unknown): SpeechEngine {
  return value === "piper" || value === "holos" ? value : "macos";
}

/** The local engines speak only Ukrainian, so English and a missing download stay on `say`. */
export function chooseSpeechEngine(engine: SpeechEngine, lang: SpeechLang, engineInstalled: boolean): SpeechEngine {
  return engine !== "macos" && lang === "uk" && engineInstalled ? engine : "macos";
}

export function normalizeSpeechRate(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SPEECH_RATE;
  return Math.min(Math.max(Math.trunc(parsed), MIN_SPEECH_RATE), MAX_SPEECH_RATE);
}

/**
 * FIFO of unspoken phrases. A newer item with the same key replaces the
 * pending one in place; an interrupted phrase goes back to the front and is
 * spoken from the start, unless a newer one for its key already arrived.
 */
export class SpeechQueue<T extends SpeechItem = SpeechItem> {
  private items: T[] = [];

  get size(): number {
    return this.items.length;
  }

  enqueue(item: T): void {
    if (item.key !== undefined) {
      const index = this.items.findIndex((pending) => pending.key === item.key);
      if (index !== -1) {
        this.items[index] = item;
        return;
      }
    }
    this.items.push(item);
    // ponytail: drop the oldest when flooded; per-key replacement keeps sessions from hitting this.
    if (this.items.length > MAX_QUEUED_ITEMS) this.items.shift();
  }

  take(): T | undefined {
    return this.items.shift();
  }

  requeue(item: T): void {
    if (item.key !== undefined && this.items.some((pending) => pending.key === item.key)) return;
    this.items.unshift(item);
  }

  clear(): void {
    this.items = [];
  }
}
