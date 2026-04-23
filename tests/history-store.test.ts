import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TranslatorHistoryStore,
  isHistoryItem,
  type HistoryItem
} from "../desktop/translator/history-store.ts";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-history-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    text: "Hello",
    translation: "Привіт",
    sourceLang: "en",
    targetLang: "uk",
    mode: "text",
    timestamp: Date.now(),
    ...overrides
  };
}

describe("TranslatorHistoryStore.list", () => {
  it("returns empty array when file missing", () => {
    const store = new TranslatorHistoryStore(dir);
    expect(store.list()).toEqual([]);
  });

  it("returns empty array when file is corrupt", () => {
    fs.writeFileSync(path.join(dir, "translator-history.json"), "not json");
    const store = new TranslatorHistoryStore(dir);
    expect(store.list()).toEqual([]);
  });

  it("filters malformed entries", () => {
    const valid = makeItem();
    const invalid = { text: "missing fields" };
    fs.writeFileSync(
      path.join(dir, "translator-history.json"),
      JSON.stringify([valid, invalid])
    );
    const store = new TranslatorHistoryStore(dir);
    expect(store.list()).toEqual([valid]);
  });
});

describe("TranslatorHistoryStore.push", () => {
  it("prepends new items (most recent first)", () => {
    const store = new TranslatorHistoryStore(dir);
    const first = makeItem({ text: "one", translation: "один", timestamp: 1 });
    const second = makeItem({ text: "two", translation: "два", timestamp: 2 });
    store.push(first);
    store.push(second);
    const list = store.list();
    expect(list[0].text).toBe("two");
    expect(list[1].text).toBe("one");
  });

  it("deduplicates identical (text, translation, targetLang, mode) entries", () => {
    const store = new TranslatorHistoryStore(dir);
    const item = makeItem({ text: "dup", translation: "dup!" });
    store.push(item);
    store.push({ ...item, timestamp: item.timestamp + 10 });
    expect(store.list()).toHaveLength(1);
  });

  it("enforces the configured limit", () => {
    const store = new TranslatorHistoryStore(dir, 3);
    for (let i = 0; i < 5; i++) {
      store.push(makeItem({ text: `t${i}`, translation: `r${i}`, timestamp: i }));
    }
    const list = store.list();
    expect(list).toHaveLength(3);
    expect(list[0].text).toBe("t4");
    expect(list[2].text).toBe("t2");
  });

  it("stores the file with 0600 permissions on POSIX", () => {
    if (process.platform === "win32") return;
    const store = new TranslatorHistoryStore(dir);
    store.push(makeItem());
    const mode = fs.statSync(path.join(dir, "translator-history.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("TranslatorHistoryStore.clear", () => {
  it("empties the file", () => {
    const store = new TranslatorHistoryStore(dir);
    store.push(makeItem());
    store.clear();
    expect(store.list()).toEqual([]);
  });
});

describe("isHistoryItem", () => {
  it("accepts a well-formed item", () => {
    expect(isHistoryItem(makeItem())).toBe(true);
  });

  it("rejects missing fields", () => {
    expect(isHistoryItem({ text: "" })).toBe(false);
    expect(isHistoryItem(null)).toBe(false);
    expect(isHistoryItem("string")).toBe(false);
  });

  it("rejects invalid mode", () => {
    expect(isHistoryItem({ ...makeItem(), mode: "other" })).toBe(false);
  });

  it("rejects non-finite timestamp", () => {
    expect(isHistoryItem({ ...makeItem(), timestamp: NaN })).toBe(false);
  });
});
