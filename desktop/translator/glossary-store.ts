// desktop/translator/glossary-store.ts
//
// Fixed terms. The translator's whole job is to change words, which is wrong
// for a class of them: identifiers (`product_flat`), command fragments
// (`bin/magento cache:flush`) and borrowed jargon (`backoff`, `rate limit`,
// `CDC`). Measured on a live model: "backoff" came back as "відступ" and
// "cache tag" once as "мітка кешу" — a translated term stops matching the
// code and stops being searchable, which is worse than leaving it English.
//
// One entry covers both cases a glossary needs:
//   • a translation for the active target language → use exactly that
//   • no translation for it                        → leave the term alone
//
// Only terms that actually occur in the text reach the prompt. A glossary
// that grows to fifty entries must not put fifty instructions in front of
// every keystroke's translation — that both costs tokens and dilutes the
// instruction the model should be following.

import fs from "node:fs";
import path from "node:path";

const FILE_NAME = "translator-glossary.json";
const MAX_ENTRIES = 200;
const MAX_TERM_LENGTH = 120;

export interface GlossaryEntry {
  /** Source term, matched case-insensitively. */
  term: string;
  /** Target-language renderings. A missing language means "keep as-is". */
  translations: Record<string, string>;
}

/**
 * Terms from `entries` that occur in `text`.
 *
 * Matching is case-insensitive and respects term boundaries, using a
 * letter/number lookaround rather than `\b` — `\b` is ASCII-only, so it
 * misses Cyrillic terms entirely, which matters the moment the glossary is
 * used in the uk→en direction. Longer terms come first so a multi-word entry
 * ("cache tag") wins over a single-word one ("tag") in the prompt.
 */
export function selectGlossaryEntries(text: string, entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  if (!text.trim() || entries.length === 0) return [];
  const matched = entries.filter((entry) => termOccursIn(text, entry.term));
  return matched.sort((a, b) => b.term.length - a.term.length);
}

export function termOccursIn(text: string, term: string): boolean {
  const needle = term.trim();
  if (!needle) return false;
  try {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{N}_])`,
      "iu"
    );
    return pattern.test(text);
  } catch {
    // A term that cannot be compiled (lone surrogate, say) falls back to a
    // plain case-insensitive search rather than silently never matching.
    return text.toLowerCase().includes(needle.toLowerCase());
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Normalizes user input into an entry, or null when the term is unusable. */
export function buildGlossaryEntry(
  term: unknown,
  targetLang?: unknown,
  translation?: unknown
): GlossaryEntry | null {
  if (typeof term !== "string") return null;
  const trimmed = term.trim().slice(0, MAX_TERM_LENGTH);
  if (!trimmed) return null;

  const entry: GlossaryEntry = { term: trimmed, translations: {} };
  if (typeof targetLang === "string" && typeof translation === "string") {
    const lang = targetLang.trim().toLowerCase();
    const value = translation.trim().slice(0, MAX_TERM_LENGTH);
    if (lang && value) entry.translations[lang] = value;
  }
  return entry;
}

export function isGlossaryEntry(value: unknown): value is GlossaryEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.term !== "string" || !v.term.trim()) return false;
  if (!v.translations || typeof v.translations !== "object") return false;
  return Object.values(v.translations as Record<string, unknown>).every(
    (translation) => typeof translation === "string"
  );
}

export class TranslatorGlossaryStore {
  private readonly filePath: string;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, FILE_NAME);
  }

  list(): GlossaryEntry[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isGlossaryEntry).slice(0, MAX_ENTRIES);
    } catch {
      return [];
    }
  }

  /**
   * Adds the term, or merges into the entry that already claims it — adding a
   * Ukrainian rendering must not drop the German one. Returns the fresh list.
   */
  upsert(entry: GlossaryEntry): GlossaryEntry[] {
    const existing = this.list();
    const index = existing.findIndex(
      (candidate) => candidate.term.toLowerCase() === entry.term.toLowerCase()
    );
    if (index === -1) {
      existing.unshift(entry);
    } else {
      existing[index] = {
        term: entry.term,
        translations: { ...existing[index].translations, ...entry.translations }
      };
    }
    const next = existing.slice(0, MAX_ENTRIES);
    this.write(next);
    return next;
  }

  remove(term: string): GlossaryEntry[] {
    const next = this.list().filter(
      (entry) => entry.term.toLowerCase() !== term.trim().toLowerCase()
    );
    this.write(next);
    return next;
  }

  clear(): GlossaryEntry[] {
    this.write([]);
    return [];
  }

  private write(entries: GlossaryEntry[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(entries, null, 2), "utf8");
    // Owner-only, same reasoning as settings.json and the history: a glossary
    // is a list of what this person works on.
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // No-op on Windows.
    }
  }
}
