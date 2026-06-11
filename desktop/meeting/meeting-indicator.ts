import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, screen } from "electron";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const rendererDir = path.join(desktopDistDir, "..", "renderer");

export class MeetingIndicator {
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
    const pillWidth = 230;
    const pillHeight = 44;
    const winX = x + width - pillWidth - 24;
    const winY = y + 16 + 112;

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

    void this.window.loadFile(path.join(rendererDir, "meeting-indicator.html"));
    this.window.showInactive();
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
  }
}
