// desktop/decks/deck-service.ts
//
// The deck the window shows (#277, stage 2): builds one from a request, opens
// a stored one, and pushes the whole view state on every change. No Electron
// and no timers; the window owns the service and drops it when it closes.

import { buildDeckHtml, buildSlideHtml, newDeckId, type Deck, type DeckLanguage } from "./deck-model.js";
import { generateDeck, type DeckRequest, type DeckStream } from "./deck-generator.js";
import type { DeckStore } from "./deck-store.js";

export type DeckStatus = "empty" | "building" | "ready" | "error";

export interface DeckViewSlide {
  /** Rail label: the outline title while building, the slide's own heading after. */
  label: string;
  /** Full document for the sandboxed frame; null until the slide is built. */
  document: string | null;
  notes: string;
}

export interface DeckViewState {
  status: DeckStatus;
  id: string | null;
  title: string;
  language: DeckLanguage | null;
  slides: DeckViewSlide[];
  /** The slide being written right now, drawn as it grows. */
  partial: { index: number; document: string } | null;
  /** `no-model`, `no-slides`, or the provider's own message. */
  error: string | null;
}

export const EMPTY_DECK_STATE: DeckViewState = {
  status: "empty",
  id: null,
  title: "",
  language: null,
  slides: [],
  partial: null,
  error: null
};

/** Plain text of the slide's first heading, else of its first words. */
export function slideLabel(html: string): string {
  const heading = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/.exec(html);
  const text = (heading ? heading[1] : html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** A file name from the deck title: letters and digits of any script, nothing a path could use. */
export function deckFileName(title: string, extension: "pdf" | "html"): string {
  const stem = title
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${stem || "deck"}.${extension}`;
}

export function deckViewState(
  deck: Deck,
  extra: { status: DeckStatus; outline?: string[]; expected?: number; partialHtml?: { index: number; html: string } | null; error?: string | null }
): DeckViewState {
  const outline = extra.outline ?? [];
  const count = Math.max(deck.slides.length, extra.status === "building" ? Math.max(outline.length, extra.expected ?? 0) : 0);
  const slides: DeckViewSlide[] = [];
  for (let i = 0; i < count; i += 1) {
    const slide = deck.slides[i];
    slides.push({
      label: (slide ? slideLabel(slide.html) : "") || outline[i] || "",
      document: slide ? buildSlideHtml(deck, i + 1) : null,
      notes: slide?.notes ?? ""
    });
  }
  const partial = extra.partialHtml;
  return {
    status: extra.status,
    id: deck.id,
    title: deck.title,
    language: deck.language,
    slides,
    partial: partial
      ? {
          index: partial.index,
          document: buildSlideHtml({ ...deck, slides: [{ layout: "content", html: partial.html, notes: "" }] }, 1) ?? ""
        }
      : null,
    error: extra.error ?? null
  };
}

export class DeckService {
  private deck: Deck | null = null;
  private view: DeckViewState = EMPTY_DECK_STATE;
  private abort: AbortController | null = null;

  constructor(
    private readonly deps: {
      store: DeckStore;
      /** Null when no provider is configured. */
      model: () => DeckStream | null;
      onChange: (state: DeckViewState) => void;
      log?: (line: string) => void;
    }
  ) {}

  state(): DeckViewState {
    return this.view;
  }

  /** The deck on screen, for export. Null while there is nothing to export. */
  current(): Deck | null {
    return this.deck && this.deck.slides.length > 0 ? this.deck : null;
  }

  exportHtml(): string | null {
    const deck = this.current();
    return deck ? buildDeckHtml(deck) : null;
  }

  /** Shows the most recently updated stored deck. False when there is none. */
  openLatest(): boolean {
    if (this.abort) return true;
    const latest = this.deps.store.list()[0];
    const deck = latest ? this.deps.store.load(latest.id) : null;
    if (!deck) return false;
    this.deck = deck;
    this.publish(deckViewState(deck, { status: "ready" }));
    return true;
  }

  /**
   * Builds a deck and resolves when the stream ends. A build already running
   * is cancelled: the newest request wins. Whatever slides arrived are saved,
   * also when the stream failed halfway.
   */
  async build(request: DeckRequest): Promise<DeckViewState> {
    this.cancel();
    const stream = this.deps.model();
    if (!stream) {
      this.publish({ ...EMPTY_DECK_STATE, status: "error", error: "no-model" });
      return this.view;
    }
    const abort = new AbortController();
    this.abort = abort;
    let outline: string[] = [];
    const building = (deck: Deck, partialHtml: { index: number; html: string } | null = null): void => {
      if (this.abort !== abort) return;
      this.deck = deck;
      this.publish(deckViewState(deck, { status: "building", outline, expected: request.slideCount, partialHtml }));
    };

    let latest: Deck | null = null;
    const result = await generateDeck({
      id: newDeckId(),
      request,
      stream,
      signal: abort.signal,
      log: this.deps.log,
      onEvent: (event) => {
        if (event.type === "outline") outline = event.titles;
        else if (event.type === "slide") building((latest = event.deck));
        else if (latest) building(latest, { index: event.index, html: event.html });
      }
    });
    // A newer build or a closed window took over: this one's result is not shown.
    if (this.abort !== abort) return this.view;
    this.abort = null;

    const deck = result.deck;
    this.deck = deck;
    if (deck.slides.length === 0) {
      this.publish({ ...EMPTY_DECK_STATE, status: "error", title: deck.title, error: result.error ?? "no-slides" });
      return this.view;
    }
    try {
      this.deps.store.save(deck);
    } catch (error) {
      this.deps.log?.(`deck not saved: ${(error as Error).message}`);
    }
    this.publish(deckViewState(deck, { status: result.error ? "error" : "ready", error: result.error }));
    return this.view;
  }

  cancel(): void {
    this.abort?.abort();
    this.abort = null;
  }

  private publish(state: DeckViewState): void {
    this.view = state;
    this.deps.onChange(state);
  }
}
