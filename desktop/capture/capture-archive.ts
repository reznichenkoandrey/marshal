// desktop/capture/capture-archive.ts
//
// Every capture that reaches the annotation editor is written here, whether or
// not the user later saves it.
//
// Without this, "capture history" only ever listed files the user had already
// chosen to keep: the history window reads the capture folder and keeps names
// starting with "Marshal " (capture-history-window.ts). The most common path
// through the editor — capture, annotate, ⌘C, close — produces no file at all,
// so the capture the user most wants back is the one history never had (#225).
//
// The archive is deliberately NOT the user's capture folder. That folder is
// theirs; filling it with every throwaway crop would be rude, and pruning it
// would risk deleting something they saved on purpose. The archive lives in
// userData, is pruned on a fixed budget, and its files are Marshal's to delete.
//
// Retention is newest-first under two caps at once — a count, so the grid
// stays navigable, and a byte budget, because a handful of 5K-display
// fullscreen PNGs outweighs a hundred small crops.

import fs from "node:fs";
import path from "node:path";

/** Newest entries kept, regardless of size. */
export const ARCHIVE_MAX_ENTRIES = 300;
/** Total bytes kept. Newest entries win; the oldest are dropped first. */
export const ARCHIVE_MAX_BYTES = 600 * 1024 * 1024;

export interface ArchivedCapture {
  path: string;
  name: string;
  bytes: number;
  modifiedAt: number;
}

/**
 * Filename for an archived capture. Shares the "Marshal <date> <time>.png"
 * shape with saved captures so the two lists read as one history, with the
 * kind appended so an area crop is distinguishable from a fullscreen grab.
 */
export function archiveFileName(when: Date, kind: string): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}.${pad(when.getMinutes())}.${pad(when.getSeconds())}`;
  const suffix = kind ? ` ${kind}` : "";
  return `Marshal ${date} ${time}${suffix}.png`;
}

/**
 * Which archived files have to go, given the caps. Pure so the retention rule
 * is testable without touching a disk.
 *
 * Entries may arrive in any order; the newest are kept. An entry is dropped
 * when it falls outside the count cap, or when everything newer than it has
 * already used up the byte budget. A single file larger than the whole budget
 * is still kept when it is the newest — deleting the capture the user just
 * took to satisfy a quota would be worse than briefly exceeding it.
 */
export function planPrune(
  entries: ArchivedCapture[],
  caps: { maxEntries: number; maxBytes: number } = {
    maxEntries: ARCHIVE_MAX_ENTRIES,
    maxBytes: ARCHIVE_MAX_BYTES
  }
): string[] {
  const newestFirst = [...entries].sort((a, b) => b.modifiedAt - a.modifiedAt);
  const doomed: string[] = [];
  let bytes = 0;

  for (let i = 0; i < newestFirst.length; i += 1) {
    const entry = newestFirst[i];
    if (i >= caps.maxEntries) {
      doomed.push(entry.path);
      continue;
    }
    if (i > 0 && bytes + entry.bytes > caps.maxBytes) {
      doomed.push(entry.path);
      continue;
    }
    bytes += entry.bytes;
  }
  return doomed;
}

export class CaptureArchive {
  private readonly dir: string;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(
    dir: string,
    caps: { maxEntries?: number; maxBytes?: number } = {}
  ) {
    this.dir = dir;
    this.maxEntries = caps.maxEntries ?? ARCHIVE_MAX_ENTRIES;
    this.maxBytes = caps.maxBytes ?? ARCHIVE_MAX_BYTES;
  }

  folder(): string {
    return this.dir;
  }

  /**
   * Writes a capture into the archive and prunes what no longer fits.
   *
   * Returns the archived path, or null when the write failed. A failure here
   * must never break the capture flow — the user has an image on screen and a
   * clipboard to fill; losing the history entry is the lesser loss. It is
   * logged rather than thrown.
   */
  record(base64: string, kind: string, when: Date = new Date()): string | null {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const target = this.uniquePath(archiveFileName(when, kind));
      fs.writeFileSync(target, Buffer.from(base64, "base64"));
      this.prune();
      return target;
    } catch (err) {
      console.warn(`[marshal] capture archive: ${(err as Error).message}`);
      return null;
    }
  }

  /** Archived captures, newest first. Missing folder reads as empty. */
  list(): ArchivedCapture[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }

    const out: ArchivedCapture[] = [];
    for (const name of names) {
      if (path.extname(name).toLowerCase() !== ".png") continue;
      const full = path.join(this.dir, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        out.push({ path: full, name, bytes: stat.size, modifiedAt: stat.mtimeMs });
      } catch {
        continue;
      }
    }
    out.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return out;
  }

  /** True when the path is inside the archive — the IPC allowlist needs it. */
  contains(filePath: string): boolean {
    const root = path.resolve(this.dir);
    const resolved = path.resolve(filePath);
    return resolved.startsWith(root + path.sep);
  }

  /**
   * Rewrites an archived capture in place, so annotating and then copying
   * leaves one history entry holding the version the user actually used —
   * rather than the untouched original plus a near-duplicate.
   *
   * Returns false when the path is not a live archive entry (outside the
   * folder, or already pruned); the caller then records a fresh entry.
   */
  replace(filePath: string, base64: string): boolean {
    if (!this.contains(filePath) || !fs.existsSync(filePath)) return false;
    try {
      fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
      return true;
    } catch (err) {
      console.warn(`[marshal] capture archive: ${(err as Error).message}`);
      return false;
    }
  }

  /** Drops one archived capture. Silently ignores anything outside the folder. */
  remove(filePath: string): boolean {
    if (!this.contains(filePath)) return false;
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private prune(): void {
    for (const doomed of planPrune(this.list(), {
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes
    })) {
      try {
        fs.unlinkSync(doomed);
      } catch {
        // A file that vanished under us needs no further attention.
      }
    }
  }

  /**
   * Two captures inside the same second collide on the name, and the second
   * one would silently overwrite the first.
   */
  private uniquePath(name: string): string {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let candidate = path.join(this.dir, name);
    for (let n = 2; fs.existsSync(candidate); n += 1) {
      candidate = path.join(this.dir, `${stem} (${n})${ext}`);
    }
    return candidate;
  }
}
