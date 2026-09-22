// desktop/captions/transcript-normalize.ts
//
// Text-level turn detection for the hands-free pipeline (V2 spec §2.2):
// strip filler words, hold back half-sentences, and recognise a question so
// the summary can be triggered the moment it ends instead of after the
// debounce. Pure functions — the interesting behaviour is pinned by tests.
//
// Word boundaries use \p{L} lookarounds, not \b: \b is ASCII-only and misses
// Cyrillic (see #147).

const FILLERS_EN = [
  "um", "umm", "uh", "uhh", "uhm", "erm", "er", "hmm", "hm", "mm", "mhm",
  "you know", "i mean", "sort of", "kind of"
];
const FILLERS_UK = [
  "е-е", "е-е-е", "еее", "ее", "ем", "емм", "ммм", "мм", "ну", "типу", "тіпа",
  "коротше", "як би", "в общем", "вобщем", "це саме", "ну от", "от"
];
/** Discourse openers that carry nothing when they start an utterance. */
const OPENERS = ["so", "well", "okay", "ok", "right", "like", "ну", "ну от", "так от", "значить", "добре"];

const INTERROGATIVES_EN = [
  "what", "why", "how", "when", "where", "which", "who", "whom", "whose",
  "can", "could", "would", "will", "should", "shall", "do", "does", "did",
  "is", "are", "was", "were", "have", "has", "had", "may", "might"
];
const INTERROGATIVES_UK = [
  "що", "чому", "як", "коли", "де", "куди", "звідки", "який", "яка", "яке", "які",
  "хто", "кого", "кому", "чи", "скільки", "навіщо", "нащо", "чим", "чого"
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function wordPattern(words: readonly string[]): RegExp {
  const alternatives = words.map(escapeRegExp).join("|");
  return new RegExp(`(?<!\\p{L})(?:${alternatives})(?!\\p{L})`, "giu");
}

const FILLER_PATTERN = wordPattern([...FILLERS_EN, ...FILLERS_UK]);
const OPENER_PATTERN = new RegExp(
  `^(?:${OPENERS.map(escapeRegExp).join("|")})(?![\\p{L}])[\\s,.!…-]*`,
  "iu"
);
/** "like" mid-sentence only when set off by commas — "I like Kafka" must survive. */
const LIKE_ASIDE = /,\s*like\s*,/giu;

/**
 * Removes filler words and cleans the punctuation they leave behind. Keeps
 * the rest of the sentence byte-for-byte: this is not a rewrite, just a
 * removal.
 */
export function stripFillers(text: string): string {
  const original = text.replace(/\s+/gu, " ").trim();
  let out = original.replace(LIKE_ASIDE, ",");
  out = out.replace(FILLER_PATTERN, "");
  out = tidy(out);
  // Openers stack ("Well, so, …"); strip up to two, re-tidying between them
  // because the first removal leaves a comma in front of the second.
  for (let i = 0; i < 2; i += 1) {
    const next = tidy(out.replace(OPENER_PATTERN, ""));
    if (next === out) break;
    out = next;
  }
  // Only a removal at the very start leaves the sentence lowercase; a text
  // that still begins with its original word keeps its original casing.
  if (out.length > 0 && !original.toLocaleLowerCase().startsWith(out.slice(0, 3).toLocaleLowerCase())) {
    out = out[0].toLocaleUpperCase() + out.slice(1);
  }
  return out;
}

/** Punctuation stranded by a removal: ", , x", "x , .", leading commas. */
function tidy(text: string): string {
  return text
    .replace(/\s+([,.!?…;:])/gu, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/gu, "$1")
    .replace(/^[\s,;:.!?…-]+/u, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

export function wordCount(text: string): number {
  return text.split(/\s+/u).filter((token) => /\p{L}|\p{N}/u.test(token)).length;
}

/**
 * A half-sentence: too short to mean anything on its own, or cut mid-word.
 * These are held back and glued to the next utterance rather than shown or
 * summarised — "and then the —" is not a caption.
 */
export function isFragment(text: string, minWords = 4): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (/[-–—…]$/u.test(trimmed)) return true;
  // Terminal punctuation is a complete thought even when short: "Yes.", "Redis?".
  if (/[.!?]$/u.test(trimmed) && wordCount(trimmed) >= 1) return false;
  return wordCount(trimmed) < minWords;
}

const INTERROGATIVE_START = new RegExp(
  `^(?:${[...INTERROGATIVES_EN, ...INTERROGATIVES_UK].map(escapeRegExp).join("|")})(?![\\p{L}])`,
  "iu"
);

/**
 * Whether the utterance is a question. Whisper punctuates reliably, so a
 * trailing "?" is the primary signal; an interrogative opener on a sentence
 * without terminal punctuation is the fallback for the cases where it does
 * not. Pitch analysis (the spec's "intonation pattern") is not attempted —
 * on transcribed text this is both cheaper and more reliable.
 */
export function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (/\?[»"”']?$/u.test(trimmed)) return true;
  if (/[.!…]$/u.test(trimmed)) return false;
  return INTERROGATIVE_START.test(trimmed) && wordCount(trimmed) >= 2;
}

/** Joins a held fragment with the utterance that followed it. */
export function joinFragment(fragment: string, next: string): string {
  const head = fragment.trim().replace(/[-–—…]+$/u, "").trim();
  if (head.length === 0) return next.trim();
  const tail = next.trim();
  const lowered = tail.length > 0 ? tail[0].toLocaleLowerCase() + tail.slice(1) : tail;
  return `${head} ${lowered}`;
}
