// desktop/dictation/dictation-indicator.ts
//
// Floating pill shown at the top-right of the primary display while dictation
// is actively recording. Mirrors capture/recording-indicator.ts in structure
// — a separate window so its lifecycle is decoupled from screen recording
// (it's legal to dictate while a screen recording runs) and so it can stack
// alongside without sharing renderer state.
//
// Non-focusable, always-on-top across spaces + fullscreen so the user always
// knows the mic is hot even when their attention is on another app. Click
// Stop → IPC → DictationService.stopRecording(). Issue #98.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, screen } from "electron";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const rendererDir = path.join(desktopDistDir, "..", "renderer");

export class DictationIndicator {
  private window: BrowserWindow | null = null;
  private readonly preloadPath: string;

  constructor(preloadPath: string) {
    this.preloadPath = preloadPath;
  }

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.showInactive();
      return;
    }
    const display = screen.getPrimaryDisplay();
    const { x, y, width } = display.bounds;
    const pillWidth = 210;
    const pillHeight = 44;
    // Top-right corner with a small margin. If the screen-recording indicator
    // is also visible it sits in the same band — offset by pillWidth + a gap
    // so they sit side-by-side rather than overlapping.
    const winX = x + width - pillWidth - 24;
    const winY = y + 16 + 56; // 56 = recording indicator height + gap, leaves room

    this.window = new BrowserWindow({
      width: pillWidth,
      height: pillHeight,
      x: winX,
      y: winY,
      frame: false,
      transparent: true,
      hasShadow: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    this.window.setAlwaysOnTop(true, "screen-saver");
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.on("closed", () => {
      this.window = null;
    });

    void this.window.loadFile(path.join(rendererDir, "dictation-indicator.html"));
    this.window.showInactive();
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
  }
}
