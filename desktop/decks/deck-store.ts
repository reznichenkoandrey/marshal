// desktop/decks/deck-store.ts
//
// Decks on disk: one JSON file per deck in `<userData>/decks/` (#277). The
// folder is passed in, so nothing here needs Electron.
//
// Unlike the capture archive, the store never deletes on its own: a deck is
// something the owner made on purpose. `overBudget()` names the oldest decks
// past the caps and the UI asks before `remove()`.

import fs from "node:fs";
import path from "node:path";

import { planPrune } from "../capture/capture-archive.js";
import { isDeckId, validateDeck, type Deck, type DeckLanguage } from "./deck-model.js";

export const DECKS_MAX_ENTRIES = 50;
export const DECKS_MAX_BYTES = 100 * 1024 * 1024;

export interface DeckSummary {
  id: string;
  title: string;
  language: DeckLanguage;
  slideCount: number;
  updatedAt: number;
  bytes: number;
}

export class DeckStore {
  constructor(
    private readonly dir: string,
    private readonly caps: { maxEntries: number; maxBytes: number } = {
      maxEntries: DECKS_MAX_ENTRIES,
      maxBytes: DECKS_MAX_BYTES
    }
  ) {}

  /** Writes the deck atomically, so a crash mid-write leaves the previous version. */
  save(deck: Deck): void {
    const target = this.pathFor(deck.id);
    if (!target) throw new Error(`invalid deck id: ${deck.id}`);
    fs.mkdirSync(this.dir, { recursive: true });
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(deck));
    fs.renameSync(temporary, target);
  }

  /** The deck, or null when it is missing or does not validate. */
  load(id: string): Deck | null {
    const target = this.pathFor(id);
    if (!target) return null;
    try {
      const deck = validateDeck(JSON.parse(fs.readFileSync(target, "utf8")));
      return deck && deck.id === id ? deck : null;
    } catch {
      return null;
    }
  }

  /** Stored decks, most recently updated first. Unreadable files are left out. */
  list(): DeckSummary[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: DeckSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const deck = this.load(name.slice(0, -".json".length));
      if (!deck) continue;
      out.push({
        id: deck.id,
        title: deck.title,
        language: deck.language,
        slideCount: deck.slides.length,
        updatedAt: deck.updatedAt,
        bytes: fs.statSync(path.join(this.dir, name)).size
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Ids of the oldest decks past the caps. Nothing is deleted here. */
  overBudget(): string[] {
    const entries = this.list().map((deck) => ({
      path: deck.id,
      name: deck.id,
      bytes: deck.bytes,
      modifiedAt: deck.updatedAt
    }));
    return planPrune(entries, this.caps);
  }

  remove(id: string): boolean {
    const target = this.pathFor(id);
    if (!target) return false;
    try {
      fs.unlinkSync(target);
      return true;
    } catch {
      return false;
    }
  }

  /** The id is checked against a strict pattern, so it cannot leave the folder. */
  private pathFor(id: string): string | null {
    return isDeckId(id) ? path.join(this.dir, `${id}.json`) : null;
  }
}
