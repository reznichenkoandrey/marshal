// desktop/translator/translator-window.ts
// Manages the floating translator BrowserWindow lifecycle.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, screen } from "electron";

const WINDOW_WIDTH = 440;
const WINDOW_HEIGHT = 400;
const CURSOR_OFFSET = 16; // px gap between cursor and window edge

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);

export class TranslatorWindow {
  private win: BrowserWindow | null = null;
  private readonly preloadPath: string;
  private readonly rendererDir: string;

  constructor(preloadPath: string) {
    this.preloadPath = preloadPath;
    // translator-window.ts compiles to dist/desktop/translator/, so go up one level
    this.rendererDir = path.join(desktopDistDir, "..", "renderer");
  }

  /** Opens the window near the cursor in empty state (no content). */
  show(): void {
    this.ensureWindow();
    this.positionNearCursor();
    this.win!.show();
    this.win!.focus();
  }

  /** Opens the window near the cursor with prefilled text. Creates it if needed. */
  showWithText(text: string, translation: string, sourceLang: string, targetLang: string): void {
    this.ensureWindow();
    this.positionNearCursor();
    this.win!.show();
    this.win!.focus();
    this.win!.webContents.send("translator-result", { text, translation, sourceLang, targetLang, mode: "text" });
  }

  /** Opens the window showing a translation-in-progress spinner. */
  showLoading(mode: "text" | "image" = "text"): void {
    this.ensureWindow();
    this.positionNearCursor();
    this.win!.show();
    this.win!.focus();
    this.win!.webContents.send("translator-loading", { mode });
  }

  /** Sends an error state to the renderer. */
  showError(message: string): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send("translator-error", { message });
  }

  /** Sends translation result for image mode. */
  showImageResult(translation: string): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send("translator-result", { translation, mode: "image" });
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
    }
  }

  isVisible(): boolean {
    return !!(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  private ensureWindow(): void {
    if (this.win && !this.win.isDestroyed()) return;

    this.win = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      show: false,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: true,
      backgroundColor: "#1e1e2e",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    void this.win.loadFile(path.join(this.rendererDir, "translator.html"));

    // Close on blur (click outside)
    this.win.on("blur", () => {
      this.win?.hide();
    });

    this.win.on("closed", () => {
      this.win = null;
    });
  }

  private positionNearCursor(): void {
    if (!this.win || this.win.isDestroyed()) return;

    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { bounds } = display;

    let x = cursor.x + CURSOR_OFFSET;
    let y = cursor.y + CURSOR_OFFSET;

    // Clamp so the window doesn't go off-screen
    if (x + WINDOW_WIDTH > bounds.x + bounds.width) {
      x = cursor.x - WINDOW_WIDTH - CURSOR_OFFSET;
    }
    if (y + WINDOW_HEIGHT > bounds.y + bounds.height) {
      y = cursor.y - WINDOW_HEIGHT - CURSOR_OFFSET;
    }

    this.win.setPosition(Math.round(x), Math.round(y));
  }
}
