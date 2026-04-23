// desktop/translator/history-store.ts
// Persists the last N translations so the user can recall them later.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_LIMIT = 20;
const FILE_NAME = "translator-history.json";

export type HistoryMode = "text" | "image";

export type HistoryItem = {
  text: string;
  translation: string;
  sourceLang: string;
  targetLang: string;
  mode: HistoryMode;
  timestamp: number;
};

export class TranslatorHistoryStore {
  private readonly filePath: string;
  private readonly limit: number;

  constructor(userDataDir: string, limit: number = DEFAULT_LIMIT) {
    this.filePath = path.join(userDataDir, FILE_NAME);
    this.limit = limit;
  }

  list(): HistoryItem[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isHistoryItem).slice(0, this.limit);
    } catch {
      return [];
    }
  }

  /**
   * Prepends the item and trims to limit. Deduplicates by exact (text,
   * translation, targetLang) triple so repeated copies of the same phrase
   * don't spam history. Returns the fresh list.
   */
  push(item: HistoryItem): HistoryItem[] {
    const existing = this.list();
    const deduped = existing.filter(
      (prev) =>
        !(
          prev.text === item.text &&
          prev.translation === item.translation &&
          prev.targetLang === item.targetLang &&
          prev.mode === item.mode
        )
    );
    const next = [item, ...deduped].slice(0, this.limit);
    this.write(next);
    return next;
  }

  clear(): void {
    this.write([]);
  }

  private write(items: HistoryItem[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(items, null, 2), "utf8");
    // Owner-only — same reasoning as settings.json (may contain personal text).
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // No-op on Windows.
    }
  }
}

export function isHistoryItem(value: unknown): value is HistoryItem {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.text === "string" &&
    typeof v.translation === "string" &&
    typeof v.sourceLang === "string" &&
    typeof v.targetLang === "string" &&
    (v.mode === "text" || v.mode === "image") &&
    typeof v.timestamp === "number" &&
    Number.isFinite(v.timestamp)
  );
}
