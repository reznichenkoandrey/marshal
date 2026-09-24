// desktop/capture/capture-history-list.ts
//
// Merging the two places a capture can live into the one list the history
// window renders:
//
//   - the user's capture folder — what they chose to save, plus recordings
//     and GIFs, which never go through the archive;
//   - the archive in userData — every capture that reached the editor,
//     including the ones only copied to the clipboard (#225).
//
// Kept separate from capture-history-window.ts so the ordering and the
// de-duplication rule can be tested without a BrowserWindow or a filesystem.

export type CaptureKind = "image" | "video" | "gif" | "other";
export type CaptureSource = "folder" | "archive";

export interface CaptureHistoryEntry {
  path: string;
  name: string;
  kind: CaptureKind;
  bytes: number;
  modifiedAt: number;
  source: CaptureSource;
}

/** Entries the history grid renders at most. */
export const HISTORY_LIST_LIMIT = 300;

/**
 * Newest first, de-duplicated, capped.
 *
 * A capture the user saved without annotating exists twice — once in the
 * capture folder, once in the archive — as two byte-identical files with
 * different names. Two tiles for one screenshot is noise, so entries of the
 * same size taken within the same minute collapse, and the folder copy wins:
 * it is the file the user knows about and can point other apps at.
 *
 * Size is the discriminator rather than a content hash on purpose. Hashing
 * every entry would mean reading a few hundred PNGs off disk every time the
 * window opens, to separate cases that differ by a byte count anyway — an
 * annotated export is never the same size as the original it came from, so
 * "original plus annotated version" correctly stays two entries.
 */
export function mergeHistoryEntries(
  folderEntries: CaptureHistoryEntry[],
  archiveEntries: CaptureHistoryEntry[],
  limit: number = HISTORY_LIST_LIMIT
): CaptureHistoryEntry[] {
  const out: CaptureHistoryEntry[] = [];
  const seen = new Set<string>();

  // Folder first, so its copy is the one that survives a collision.
  for (const entry of [...folderEntries, ...archiveEntries]) {
    const key = duplicateKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }

  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out.slice(0, limit);
}

/** Same bytes, same minute, same kind — one capture stored in two places. */
function duplicateKey(entry: CaptureHistoryEntry): string {
  const minute = Math.floor(entry.modifiedAt / 60_000);
  return `${entry.kind}:${entry.bytes}:${minute}`;
}
