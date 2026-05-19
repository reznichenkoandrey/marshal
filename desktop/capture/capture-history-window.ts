// desktop/capture/capture-history-window.ts
//
// Floating window that lists recent captures (PNG / MOV / GIF) saved into the
// user's capture folder. The grid is renderer-side; main only reads the
// directory once on demand and pushes the list in.
//
// Reopening an image hands it back to the annotation editor for re-edits;
// reopening a video / GIF asks the OS to open it in its default app.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, shell } from "electron";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const rendererDir = path.join(desktopDistDir, "..", "renderer");

export interface CaptureHistoryEntry {
  path: string;
  name: string;
  kind: "image" | "video" | "gif" | "other";
  bytes: number;
  modifiedAt: number;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXT = new Set([".mov", ".mp4"]);
const GIF_EXT = new Set([".gif"]);

export class CaptureHistoryWindow {
  private window: BrowserWindow | null = null;
  private readonly preloadPath: string;
  private resolveFolder: () => string;

  constructor(preloadPath: string, resolveFolder: () => string) {
    this.preloadPath = preloadPath;
    this.resolveFolder = resolveFolder;
  }

  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      this.pushEntries();
      return;
    }

    this.window = new BrowserWindow({
      width: 880,
      height: 620,
      minWidth: 520,
      minHeight: 360,
      show: false,
      frame: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
      backgroundColor: "#131316",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    this.window.on("closed", () => {
      this.window = null;
    });

    this.window.webContents.once("did-finish-load", () => {
      this.pushEntries();
      this.window?.show();
      this.window?.focus();
    });

    void this.window.loadFile(path.join(rendererDir, "capture-history.html"));
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
  }

  /** Force a re-read of the folder and push the entries to the renderer. */
  refresh(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.pushEntries();
  }

  /** Hand a file off to its OS-default app. Used by renderer for non-image kinds. */
  async revealOrOpen(filePath: string, mode: "open" | "reveal"): Promise<{ ok: boolean; error?: string }> {
    if (!this.belongsToFolder(filePath)) {
      return { ok: false, error: "Path is outside the capture folder." };
    }
    try {
      if (mode === "reveal") {
        shell.showItemInFolder(filePath);
      } else {
        const failure = await shell.openPath(filePath);
        if (failure) return { ok: false, error: failure };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Load a PNG payload from disk so the caller can hand it to the editor. */
  async readImage(filePath: string): Promise<{ base64: string; width: number; height: number } | null> {
    if (!this.belongsToFolder(filePath)) return null;
    if (!IMAGE_EXT.has(path.extname(filePath).toLowerCase())) return null;
    try {
      const buf = await fs.promises.readFile(filePath);
      return { base64: buf.toString("base64"), width: 0, height: 0 };
    } catch {
      return null;
    }
  }

  /**
   * Defence against the renderer asking us to open something outside the
   * capture folder. We compare resolved paths, not raw strings, so symlinks
   * cannot widen the allowlist.
   */
  private belongsToFolder(filePath: string): boolean {
    const folder = path.resolve(this.resolveFolder() || defaultFolder());
    const resolved = path.resolve(filePath);
    return resolved === folder || resolved.startsWith(folder + path.sep);
  }

  private pushEntries(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const folder = this.resolveFolder() || defaultFolder();
    const entries = listFolder(folder);
    this.window.webContents.send("marshal:capture-history-loaded", { folder, entries });
  }
}

function defaultFolder(): string {
  return path.join(os.homedir(), "Desktop");
}

function listFolder(folder: string): CaptureHistoryEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }

  const out: CaptureHistoryEntry[] = [];
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    const kind = classify(ext);
    if (kind === "other") continue;
    // Only show Marshal-produced captures so the grid doesn't fill up with
    // every screenshot the user already had on the Desktop. Defaults to all
    // PNGs/MOVs whose name starts with "Marshal " (the prefix used by the
    // recorder and the bridge writer).
    if (!name.startsWith("Marshal ")) continue;

    const full = path.join(folder, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      path: full,
      name,
      kind,
      bytes: stat.size,
      modifiedAt: stat.mtimeMs
    });
  }

  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  // Cap the grid at 60 newest entries — older captures stay on disk but the
  // window doesn't try to render 1000s of thumbnails.
  return out.slice(0, 60);
}

function classify(ext: string): CaptureHistoryEntry["kind"] {
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (GIF_EXT.has(ext)) return "gif";
  return "other";
}
