// desktop/capture/gif-dialog.ts
//
// Small modal BrowserWindow that drives the GIF conversion. Collects
// fps/width/loop from the user, streams progress back from GifEncoder, and
// closes itself when the encode finishes.
//
// Everything is instantiated lazily — the window is only created when the
// user explicitly triggers "Convert video to GIF…" from the tray or (later)
// from a post-recording notification.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow } from "electron";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const rendererDir = path.join(desktopDistDir, "..", "renderer");

export interface GifDialogInit {
  /** Path to the source .mov / .mp4. Shown as the pre-selected file. */
  inputPath: string;
}

export class GifDialog {
  private window: BrowserWindow | null = null;
  private readonly preloadPath: string;

  constructor(preloadPath: string) {
    this.preloadPath = preloadPath;
  }

  open(init: GifDialogInit): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      this.send(init);
      return;
    }

    this.window = new BrowserWindow({
      width: 460,
      height: 360,
      resizable: false,
      minimizable: false,
      maximizable: false,
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
      this.send(init);
      this.window?.show();
      this.window?.focus();
    });

    void this.window.loadFile(path.join(rendererDir, "gif-dialog.html"));
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
  }

  sendProgress(progress: number): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("marshal:gif-progress", { progress });
  }

  sendDone(outputPath: string): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("marshal:gif-done", { outputPath });
  }

  sendError(message: string): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("marshal:gif-error", { message });
  }

  private send(init: GifDialogInit): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("marshal:gif-init", { inputPath: init.inputPath });
  }
}
