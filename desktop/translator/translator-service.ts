// desktop/translator/translator-service.ts
// Translator facade: picks a backend (Claude CLI / Codex CLI / Claude API /
// OpenAI-compatible) and delegates translateText/translateImage/translateAuto
// to it. Can follow the main "Reasoning provider" setting ("auto") or be
// pinned to an explicit backend. Also owns the active language pair, which the
// hotkey path needs in order to choose a direction on its own.

import { EventEmitter } from "node:events";

import { isBackendUnusableError, type BackendUnusableReason } from "./backends/errors.ts";
import { createTranslatorBackend, resolveTranslatorBackendId, translatorBackendForBridge } from "./backends/factory.ts";
import { selectGlossaryEntries, type GlossaryEntry } from "./glossary-store.ts";
import { detectScriptLang } from "./languages.ts";
import type {
  Formality,
  LangCode,
  SourceLang,
  TargetLang,
  TranslateOptions,
  TranslationResult,
  TranslatorBackend,
  TranslatorBackendId,
  TranslatorBridgeMode
} from "./backends/types.ts";

export type {
  Formality,
  LangCode,
  SourceLang,
  TargetLang,
  TranslateOptions,
  TranslationResult,
  TranslatorBackendId
} from "./backends/types.ts";

export type TranslatorBackendChoice = TranslatorBackendId | "auto";

/** Emitted as `"fallback"` when a backend cannot serve requests. */
export interface TranslatorFallbackNotice {
  from: TranslatorBackendId;
  to: TranslatorBackendId;
  status: number;
  /** Why it was unusable — the notice says different things for each. */
  reason: BackendUnusableReason;
  /** The model that was missing, when `reason` is "model". */
  model?: string;
}

const DEFAULT_BRIDGE: TranslatorBridgeMode = "claude-cli";
const DEFAULT_SOURCE: SourceLang = "auto";
const DEFAULT_TARGET: TargetLang = "uk";
/** Pair the app falls back to when auto-detect lands on the target language. */
const NATIVE_PAIR: readonly [LangCode, LangCode] = ["uk", "en"];

export interface TranslatorServiceInit {
  choice?: TranslatorBackendChoice;
  bridgeMode?: TranslatorBridgeMode;
  sourceLang?: SourceLang;
  targetLang?: TargetLang;
  formality?: Formality;
}

export class TranslatorService extends EventEmitter {
  private backend: TranslatorBackend;
  /**
   * A backend whose credential was rejected this session. `auto` stops
   * choosing it, so we don't pay a doomed round trip per keystroke. Cleared
   * whenever the user changes provider settings, since that is the moment a
   * fixed key would show up.
   */
  private rejectedBackend: TranslatorBackendId | null = null;
  /** Fixed terms, whole list; only the ones in the text reach a prompt. */
  private glossary: readonly GlossaryEntry[] = [];
  private choice: TranslatorBackendChoice;
  private bridgeMode: TranslatorBridgeMode;
  private sourceLang: SourceLang;
  private targetLang: TargetLang;
  private formality: Formality;

  constructor(init: TranslatorServiceInit = {}) {
    super();
    this.bridgeMode = init.bridgeMode ?? DEFAULT_BRIDGE;
    this.choice = init.choice ?? "auto";
    this.sourceLang = init.sourceLang ?? DEFAULT_SOURCE;
    this.targetLang = init.targetLang ?? DEFAULT_TARGET;
    this.formality = init.formality ?? "default";
    this.backend = createTranslatorBackend(this.resolveBackendId());
  }

  /** The concrete backend currently servicing translations. */
  get backendId(): TranslatorBackendId {
    return this.backend.id;
  }

  /** Language pair the hotkey / OCR paths translate with. */
  get languagePair(): { sourceLang: SourceLang; targetLang: TargetLang; formality: Formality } {
    return { sourceLang: this.sourceLang, targetLang: this.targetLang, formality: this.formality };
  }

  /** Swap the backend choice at runtime (e.g. after Settings change). */
  setBackend(choice: TranslatorBackendChoice): void {
    this.choice = choice;
    this.rejectedBackend = null;
    this.rebuildBackend();
  }

  /** React to a "Reasoning provider" change so `auto` stays in sync. */
  setBridgeMode(mode: TranslatorBridgeMode): void {
    if (this.bridgeMode === mode) return;
    this.bridgeMode = mode;
    this.rejectedBackend = null;
    if (this.choice === "auto") {
      this.rebuildBackend();
    }
  }

  /** Replaces the glossary; main calls this on load and after every edit. */
  setGlossary(entries: readonly GlossaryEntry[]): void {
    this.glossary = entries;
  }

  /** Called whenever the renderer changes the pair, so hotkeys follow the UI. */
  setLanguagePair(sourceLang: SourceLang, targetLang: TargetLang, formality: Formality = this.formality): void {
    this.sourceLang = sourceLang;
    this.targetLang = targetLang;
    this.formality = formality;
  }

  translateText(text: string, targetLang: TargetLang, options?: TranslateOptions): Promise<TranslationResult> {
    const filled = this.withDefaults(options, text);
    return this.run((backend) => backend.translateText(text, targetLang, filled));
  }

  translateImage(
    base64: string,
    mimeType: string,
    targetLang: TargetLang,
    options?: TranslateOptions
  ): Promise<TranslationResult> {
    const filled = this.withDefaults(options);
    return this.run((backend) => backend.translateImage(base64, mimeType, targetLang, filled));
  }

  /**
   * Translates without the UI telling us a direction — the double-⌘C and
   * ⌘⌥T hotkeys. The script heuristic decides direction up front: text that
   * is already in the target language goes the other way, everything else
   * goes to the target. Deterministic, and it still holds when the backend
   * call later fails.
   */
  translateAuto(text: string): Promise<TranslationResult> {
    const targetLang = this.autoTarget(text);
    const options = this.withDefaults({ sourceLang: "auto" }, text);
    return this.run((backend) => backend.translateText(text, targetLang, options));
  }

  /**
   * Runs a translation, and survives a rejected credential.
   *
   * When `auto` picked the backend, the user never chose that provider — so a
   * 401 is our problem to solve, not theirs: swap to whatever the reasoning
   * provider maps to (a CLI, which needs no key) and run the same call again.
   * The swap is announced through `"fallback"` exactly once, because the
   * alternative is a translator that silently got ten times slower.
   *
   * An explicitly pinned backend is left to fail loudly — the user asked for
   * that provider, and hiding its auth error would hide the thing they need
   * to fix. See #160.
   */
  private async run<T>(call: (backend: TranslatorBackend) => Promise<T>): Promise<T> {
    try {
      return await call(this.backend);
    } catch (err) {
      if (this.choice !== "auto" || !isBackendUnusableError(err)) throw err;

      const from = this.backend.id;
      this.rejectedBackend = from;
      this.rebuildBackend();
      if (this.backend.id === from) {
        // Nothing to fall back to — surface the original error.
        this.rejectedBackend = null;
        throw err;
      }

      const failure = err as { status?: number; reason?: BackendUnusableReason; model?: string };
      const notice: TranslatorFallbackNotice = {
        from,
        to: this.backend.id,
        status: failure.status ?? 401,
        reason: failure.reason ?? "auth"
      };
      if (failure.model !== undefined) notice.model = failure.model;
      this.emit("fallback", notice);
      return call(this.backend);
    }
  }

  /** Target language `translateAuto` would pick for this text. */
  autoTarget(text: string): TargetLang {
    const detected = detectScriptLang(text);
    if (detected !== this.targetLang) return this.targetLang;
    if (this.sourceLang !== "auto") return this.sourceLang;
    // Both sides are the same language: flip within the app's native pair.
    const [first, second] = NATIVE_PAIR;
    return this.targetLang === first ? second : first;
  }

  /**
   * Fills in the configured source/formality, and the glossary terms that
   * actually occur in `text`. With no text (the image path) the whole
   * glossary would have to go in blind, which is exactly the prompt bloat
   * the filtering exists to avoid — so images get no terms unless the caller
   * passes them.
   */
  private withDefaults(options: TranslateOptions | undefined, text?: string): TranslateOptions {
    const filled: TranslateOptions = {
      sourceLang: options?.sourceLang ?? this.sourceLang,
      formality: options?.formality ?? this.formality
    };
    const glossary = options?.glossary
      ?? (text !== undefined ? selectGlossaryEntries(text, this.glossary) : []);
    if (glossary.length > 0) filled.glossary = glossary;
    return filled;
  }

  private resolveBackendId(): TranslatorBackendId {
    if (this.choice !== "auto") return this.choice;

    // Read the env on every resolve rather than caching it in the
    // constructor: the packaged app loads a second .env from its userData
    // directory, and Settings changes re-run applySettingsToEnv, so the key
    // can appear after this service was built.
    const preferred = translatorBackendForBridge(this.bridgeMode, {
      apiKeyPresent: Boolean(process.env.MARSHAL_API_KEY?.trim()),
      platform: process.platform
    });
    if (preferred !== this.rejectedBackend) return preferred;

    // The fast backend's credential was already refused. Resolve as if no key
    // existed, which is the keyless mapping of the reasoning provider.
    return translatorBackendForBridge(this.bridgeMode);
  }

  private rebuildBackend(): void {
    const id = this.resolveBackendId();
    if (this.backend.id === id) return;
    this.backend = createTranslatorBackend(id);
  }
}

export function resolveTranslatorChoice(raw: string | undefined, fallback: TranslatorBackendChoice): TranslatorBackendChoice {
  if (typeof raw !== "string") return fallback;
  const candidate = raw.trim().toLowerCase();
  if (candidate === "auto") return "auto";
  return resolveTranslatorBackendId(candidate, fallback === "auto" ? "claude-cli" : fallback);
}

// Re-export helpers so existing tests can import them from this module.
export {
  detectLangHeuristic,
  extractBracedJson,
  parseFloatEnv,
  parseIntEnv,
  parseRetryAfterMs,
  parseTranslateJson,
  stripCodeFence
} from "./backends/shared.ts";
export type { TranslateJsonResult } from "./backends/shared.ts";
