// desktop/decks/deck-model.ts
//
// Deck types, validation of model operations and of stored files, and the
// HTML a deck renders to (#277). Pure: no Electron, no disk, no network.

import { escapeHtml, sanitizeSlideHtml } from "./sanitize.js";

export const DECK_LANGUAGES = ["uk", "en"] as const;
export type DeckLanguage = (typeof DECK_LANGUAGES)[number];

export const DECK_THEMES = ["dark", "light"] as const;
export type DeckTheme = (typeof DECK_THEMES)[number];

export const SLIDE_LAYOUTS = ["title", "bullets", "content", "quote"] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

export const MAX_SLIDES = 40;
export const MAX_SLIDE_HTML_CHARS = 64 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_NOTES_CHARS = 4000;

export interface Slide {
  layout: SlideLayout;
  /** Always sanitised. */
  html: string;
  /** Speaker notes: presenter mode and speech only, never in an export. */
  notes: string;
}

export interface Deck {
  id: string;
  title: string;
  language: DeckLanguage;
  theme: DeckTheme;
  slides: Slide[];
  createdAt: number;
  updatedAt: number;
}

export type DeckOp =
  | { op: "deck"; title: string; theme?: DeckTheme; language?: DeckLanguage; outline?: string[] }
  | { op: "slide"; index: number; layout: SlideLayout; html: string; notes: string };

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

const DECK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isDeckId(id: unknown): id is string {
  return typeof id === "string" && DECK_ID.test(id);
}

export function newDeckId(now: number = Date.now(), random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 36 ** 4).toString(36).padStart(4, "0");
  return `deck-${now.toString(36)}-${suffix}`;
}

export function createDeck(input: {
  id: string;
  title?: string;
  language: DeckLanguage;
  theme?: DeckTheme;
  now?: number;
}): Deck {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    title: clip(input.title ?? "", MAX_TITLE_CHARS),
    language: input.language,
    theme: input.theme ?? "dark",
    slides: [],
    createdAt: now,
    updatedAt: now
  };
}

/** Turns one scanned JSON object into an operation, or says why it is not one. */
export function parseDeckOp(raw: unknown): Checked<DeckOp> {
  if (!isRecord(raw)) return { ok: false, reason: "operation is not an object" };
  if (raw.op === "deck") {
    if (typeof raw.title !== "string") return { ok: false, reason: "deck: title is not a string" };
    return {
      ok: true,
      value: {
        op: "deck",
        title: clip(raw.title, MAX_TITLE_CHARS),
        theme: oneOf(DECK_THEMES, raw.theme),
        language: oneOf(DECK_LANGUAGES, raw.language),
        // Slide titles announced ahead of the slides; shown while they build, not stored.
        outline: Array.isArray(raw.outline)
          ? raw.outline
              .filter((title): title is string => typeof title === "string")
              .slice(0, MAX_SLIDES)
              .map((title) => clip(title, MAX_TITLE_CHARS))
          : undefined
      }
    };
  }
  if (raw.op === "slide") {
    const index = raw.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > MAX_SLIDES) {
      return { ok: false, reason: `slide: index ${String(index)} is not an integer in 1..${MAX_SLIDES}` };
    }
    if (typeof raw.html !== "string") return { ok: false, reason: `slide ${index}: html is not a string` };
    if (raw.html.length > MAX_SLIDE_HTML_CHARS) {
      return { ok: false, reason: `slide ${index}: html exceeds ${MAX_SLIDE_HTML_CHARS} characters` };
    }
    return {
      ok: true,
      value: {
        op: "slide",
        index,
        layout: oneOf(SLIDE_LAYOUTS, raw.layout) ?? "content",
        html: raw.html,
        notes: typeof raw.notes === "string" ? clip(raw.notes, MAX_NOTES_CHARS) : ""
      }
    };
  }
  return { ok: false, reason: `unknown op ${JSON.stringify(raw.op)}` };
}

/**
 * Applies one operation and returns a new deck. A slide replaces the one at
 * its index or becomes the next one; an index that would leave a gap is
 * refused, so a stream that lost a slide cannot renumber the ones after it.
 */
export function applyDeckOp(deck: Deck, op: DeckOp, now: number = Date.now()): Checked<Deck> {
  if (op.op === "deck") {
    return {
      ok: true,
      value: {
        ...deck,
        title: op.title,
        theme: op.theme ?? deck.theme,
        language: op.language ?? deck.language,
        updatedAt: now
      }
    };
  }
  if (op.index > deck.slides.length + 1) {
    return { ok: false, reason: `slide: index ${op.index} skips past slide ${deck.slides.length}` };
  }
  const slides = [...deck.slides];
  slides[op.index - 1] = { layout: op.layout, html: sanitizeSlideHtml(op.html), notes: op.notes };
  return { ok: true, value: { ...deck, slides, updatedAt: now } };
}

/** A deck read back from disk: anything malformed is refused, html is re-sanitised. */
export function validateDeck(raw: unknown): Deck | null {
  if (!isRecord(raw) || !isDeckId(raw.id) || typeof raw.title !== "string") return null;
  const language = oneOf(DECK_LANGUAGES, raw.language);
  const theme = oneOf(DECK_THEMES, raw.theme);
  if (!language || !theme || !Array.isArray(raw.slides) || raw.slides.length > MAX_SLIDES) return null;
  if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) return null;

  const slides: Slide[] = [];
  for (const slide of raw.slides as unknown[]) {
    if (!isRecord(slide) || typeof slide.html !== "string" || slide.html.length > MAX_SLIDE_HTML_CHARS) {
      return null;
    }
    slides.push({
      layout: oneOf(SLIDE_LAYOUTS, slide.layout) ?? "content",
      html: sanitizeSlideHtml(slide.html),
      notes: typeof slide.notes === "string" ? clip(slide.notes, MAX_NOTES_CHARS) : ""
    });
  }
  return {
    id: raw.id,
    title: clip(raw.title, MAX_TITLE_CHARS),
    language,
    theme,
    slides,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

/** Same policy the render window has to enforce; a file opened in a browser gets it from the meta tag. */
export const DECK_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

// A deck is a standalone document shown in a sandboxed frame or a browser, so
// it carries its own palette; the app's design tokens do not reach it.
const THEME_COLORS: Record<DeckTheme, string> = {
  dark: "--deck-bg:#0e1116;--deck-fg:#e8ecf2;--deck-muted:#97a3b4;--deck-accent:#6aa6ff;--deck-line:#263041",
  light: "--deck-bg:#ffffff;--deck-fg:#161a20;--deck-muted:#5a6675;--deck-accent:#1f5fd0;--deck-line:#d7dde6"
};

// System fonts only: SF and Helvetica Neue both carry Cyrillic.
const DECK_CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:var(--deck-bg);color:var(--deck-fg);font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.slide{width:100vw;height:56.25vw;max-height:100vh;margin:0 auto;padding:6vw 7vw;display:flex;flex-direction:column;justify-content:center;gap:1.6vw;overflow:hidden;font-size:2.4vw;line-height:1.35;border-bottom:1px solid var(--deck-line)}
.slide:last-child{border-bottom:0}
.slide h1{font-size:5.2vw;line-height:1.1;margin:0}
.slide h2{font-size:3.6vw;line-height:1.15;margin:0}
.slide h3,.slide h4{font-size:2.8vw;margin:0;color:var(--deck-muted)}
.slide p,.slide ul,.slide ol,.slide blockquote,.slide pre,.slide figure{margin:0}
.slide ul,.slide ol{padding-left:1.2em;display:flex;flex-direction:column;gap:.5em}
.slide li::marker{color:var(--deck-accent)}
.slide code,.slide pre{font-family:ui-monospace,Menlo,monospace;font-size:.85em}
.slide img{max-width:100%;max-height:60%;object-fit:contain}
.slide table{border-collapse:collapse;font-size:.85em}
.slide th,.slide td{border-bottom:1px solid var(--deck-line);padding:.4em .8em;text-align:left}
.slide.layout-title{align-items:center;text-align:center}
.slide.layout-title p{color:var(--deck-muted)}
.slide.layout-quote blockquote{font-size:1.5em;border-left:.25em solid var(--deck-accent);padding-left:.8em}
@page{size:1280px 720px;margin:0}
@media print{.slide{width:1280px;height:720px;max-height:none;padding:77px 90px;gap:20px;font-size:31px;border:0;break-after:page}.slide:last-child{break-after:auto}.slide h1{font-size:67px}.slide h2{font-size:46px}.slide h3,.slide h4{font-size:36px}}
`.trim();

function buildDocument(deck: Deck, slides: Slide[]): string {
  const sections = slides
    .map((slide) => `<section class="slide layout-${slide.layout}">${sanitizeSlideHtml(slide.html)}</section>`)
    .join("\n");
  return [
    "<!doctype html>",
    `<html lang="${deck.language}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${DECK_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(deck.title)}</title>`,
    `<style>:root{${THEME_COLORS[deck.theme]}}\n${DECK_CSS}</style>`,
    "</head>",
    "<body>",
    sections,
    "</body>",
    "</html>"
  ].join("\n");
}

/** Self-contained export: every slide, no scripts, no external resources, no notes. */
export function buildDeckHtml(deck: Deck): string {
  return buildDocument(deck, deck.slides);
}

/** One slide as a full document, for a sandboxed frame's `srcdoc`. Index is 1-based. */
export function buildSlideHtml(deck: Deck, index: number): string | null {
  const slide = deck.slides[index - 1];
  return slide ? buildDocument(deck, [slide]) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((item) => item === value);
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
