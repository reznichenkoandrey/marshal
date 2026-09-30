// "Meeting Recordings" window: every call MeetingRecorder saved, newest
// first, with an inline player. Deleting moves the recording's folder to the
// Trash rather than unlinking it — a call is not something to lose to a misclick.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, shell } from "electron";

import type { MeetingLibrary } from "./meeting-library.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const rendererDir = path.join(desktopDistDir, "..", "renderer");

export class MeetingHistoryWindow {
  private window: BrowserWindow | null = null;

  constructor(
    private readonly preloadPath: string,
    private readonly library: MeetingLibrary,
    private readonly libraryRoot: string,
    private readonly activeId: () => string | null
  ) {}

  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      this.refresh();
      return;
    }

    this.window = new BrowserWindow({
      width: 820,
      height: 600,
      minWidth: 520,
      minHeight: 360,
      show: false,
      frame: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
      backgroundColor: "#131316",
      // LSUIElement app: a plain window that falls behind another app has no
      // way back to the front (see CLAUDE.md, #168).
      alwaysOnTop: true,
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
      this.refresh();
      this.window?.show();
      this.window?.focus();
    });
    void this.window.loadFile(path.join(rendererDir, "meeting-history.html"));
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
  }

  refresh(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("marshal:meeting-history-loaded", {
      folder: this.libraryRoot,
      entries: this.library.list(this.activeId())
    });
  }

  reveal(filePath: string): { ok: boolean; error?: string } {
    if (!this.library.contains(filePath)) return { ok: false, error: "Path is outside the recordings folder." };
    shell.showItemInFolder(filePath);
    return { ok: true };
  }

  async trash(id: string): Promise<{ ok: boolean; error?: string }> {
    if (id === this.activeId()) return { ok: false, error: "This recording is still in progress." };
    const folder = this.library.folderFor(id);
    if (!folder) return { ok: false, error: "Recording not found." };
    try {
      await shell.trashItem(folder);
      this.refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
