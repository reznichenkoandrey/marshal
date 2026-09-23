// desktop/captions/caption-translation.ts
//
// Live translation of finished caption lines (#210, V3 spec §2.3). One request
// per line through the translator the caller injects — the app's
// TranslatorService, so the backend chosen in Settings and the glossary apply
// without any captions-specific configuration.
//
// Translations are keyed by the line's text, not by its position. That is
// what makes out-of-order answers harmless: a reply for "we shard by tenant"
// attaches to that text wherever it is on screen now, and a line rewritten
// by the continuation merge (#202) is simply a new key that gets its own
// request. Nothing here knows about the overlay; the service asks for the
// translation of whatever it is about to draw.
//
// No Electron imports, so the caching, de-duplication and failure rules are
// tested with a fake translator.

export type TranslateLine = (text: string, targetLang: string) => Promise<string>;

/** Lines remembered. Bounded so a long call cannot grow the cache forever. */
export const MAX_CACHED_TRANSLATIONS = 200;
/**
 * After a failed request, no new requests for this long. A translator that
 * is rate-limited or down would otherwise be asked again for every line.
 */
export const TRANSLATION_COOLDOWN_MS = 30_000;

export interface CaptionTranslatorOptions {
  translate: TranslateLine;
  targetLang: string;
  maxCached?: number;
  cooldownMs?: number;
  /** Called once per failure, for the log. */
  onError?: (err: unknown) => void;
  /** Called whenever a translation lands, so the overlay can repaint. */
  onUpdate?: () => void;
}

export class CaptionTranslator {
  private readonly done = new Map<string, string | null>();
  private readonly inFlight = new Set<string>();
  private cooldownUntil = 0;
  private readonly maxCached: number;
  private readonly cooldownMs: number;

  constructor(private readonly options: CaptionTranslatorOptions) {
    this.maxCached = options.maxCached ?? MAX_CACHED_TRANSLATIONS;
    this.cooldownMs = options.cooldownMs ?? TRANSLATION_COOLDOWN_MS;
  }

  get targetLang(): string {
    return this.options.targetLang;
  }

  /**
   * The translation of `text`, or null while it is pending, failed, or turned
   * out identical to the original (whisper already produced the target
   * language — showing the same line twice would only cost screen space).
   */
  get(text: string): string | null {
    return this.done.get(text) ?? null;
  }

  /** Requests the translation of `text` unless it is known or in flight. */
  request(text: string, now = Date.now()): void {
    const key = text.trim();
    if (key.length === 0 || this.done.has(key) || this.inFlight.has(key)) return;
    if (now < this.cooldownUntil) return;

    this.inFlight.add(key);
    this.options
      .translate(key, this.options.targetLang)
      .then((translation) => {
        this.remember(key, normalizeTranslation(key, translation));
        this.options.onUpdate?.();
      })
      .catch((err: unknown) => {
        // Remembered as "no translation" so this line is not retried on
        // every repaint; the cool-down covers the lines that follow.
        this.remember(key, null);
        this.cooldownUntil = Date.now() + this.cooldownMs;
        this.options.onError?.(err);
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
  }

  isPending(text: string): boolean {
    return this.inFlight.has(text.trim());
  }

  clear(): void {
    this.done.clear();
    this.inFlight.clear();
    this.cooldownUntil = 0;
  }

  private remember(key: string, translation: string | null): void {
    this.done.set(key, translation);
    // Map keeps insertion order: the oldest entry is the first one.
    while (this.done.size > this.maxCached) {
      const oldest = this.done.keys().next().value;
      if (oldest === undefined) break;
      this.done.delete(oldest);
    }
  }
}

/**
 * A translation worth showing, or null when it adds nothing: empty, or the
 * same words as the original up to whitespace and case.
 */
export function normalizeTranslation(original: string, translation: string): string | null {
  const cleaned = translation.trim().replace(/\s+/gu, " ");
  if (cleaned.length === 0) return null;
  const fold = (text: string) => text.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  return fold(cleaned) === fold(original) ? null : cleaned;
}

/**
 * Target language from `MARSHAL_CAPTIONS_TRANSLATE`: a language code, or
 * null when translation is off. Unset means Ukrainian — the V3 spec's
 * "dual-language (English to Ukrainian)" is the point of the feature.
 */
export function resolveTranslationTarget(
  raw: string | undefined,
  resolveCode: (raw: unknown, fallback: "uk") => string
): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "off" || value === "0" || value === "none" || value === "false") return null;
  return resolveCode(value.length > 0 ? value : "uk", "uk");
}
