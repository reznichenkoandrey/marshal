// desktop/translator/translator-window.ts
// Manages the floating translator BrowserWindow lifecycle.
//
// Two modes, mirroring how a desktop translator is actually used:
//   • unpinned (default) — a glance tool. Opens next to the cursor at the
//     remembered size and hides as soon as it loses focus.
//   • pinned — a workbench. Stays where the user put it, keeps its own size,
//     and survives clicking into another app so text can be typed there and
//     translated here side by side.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, screen } from "electron";

import { shouldHideOnBlur } from "./window-policy.ts";

const DEFAULT_WIDTH = 760;
const DEFAULT_HEIGHT = 470;
const MIN_WIDTH = 520;
const MIN_HEIGHT = 340;
const CURSOR_OFFSET = 16; // px gap between cursor and window edge
const STATE_FILE = "translator-window-state.json";

interface TranslatorWindowState {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  pinned: boolean;
}

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);

export class TranslatorWindow {
  private win: BrowserWindow | null = null;
  private readonly preloadPath: string;
  private readonly rendererDir: string;
  private readonly statePath: string | null;
  private state: TranslatorWindowState;
  /**
   * Whether the source field holds text. The renderer owns the field, so it
   * reports the empty↔non-empty transitions; main cannot see them.
   */
  private hasContent = false;

  constructor(preloadPath: string, userDataDir?: string) {
    this.preloadPath = preloadPath;
    // translator-window.ts compiles to dist/desktop/translator/, so go up one level
    this.rendererDir = path.join(desktopDistDir, "..", "renderer");
    this.statePath = userDataDir ? path.join(userDataDir, STATE_FILE) : null;
    this.state = this.readState();
  }

  /** Opens the window in empty state (no content). */
  show(): void {
    this.ensureWindow();
    this.place();
    this.win!.show();
    this.win!.focus();
  }

  /** Opens the window with prefilled text. Creates it if needed. */
  showWithText(text: string, translation: string, sourceLang: string, targetLang: string): void {
    this.ensureWindow();
    this.place();
    this.win!.show();
    this.win!.focus();
    this.win!.webContents.send("translator-result", { text, translation, sourceLang, targetLang, mode: "text" });
  }

  /** Opens the window showing a translation-in-progress spinner. */
  showLoading(mode: "text" | "image" = "text"): void {
    this.ensureWindow();
    this.place();
    this.win!.show();
    this.win!.focus();
    this.win!.webContents.send("translator-loading", { mode });
  }

  /** Sends an error state to the renderer. */
  showError(message: string): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send("translator-error", { message });
  }

  /**
   * A non-blocking note in the translator window. Used when the service had
   * to swap backends behind the user's back (#160) — without it the only
   * symptom is that translation suddenly takes ten seconds.
   */
  showNotice(message: string): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send("translator-notice", { message });
  }

  /** Sends translation result for image mode. */
  showImageResult(translation: string, targetLang = "uk"): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send("translator-result", { translation, mode: "image", targetLang });
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.captureBounds();
      this.win.hide();
    }
  }

  isVisible(): boolean {
    return !!(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  isPinned(): boolean {
    return this.state.pinned;
  }

  isFocused(): boolean {
    return !!(this.win && !this.win.isDestroyed() && this.win.isFocused());
  }

  /** Called by the renderer whenever the source field empties or fills. */
  setHasContent(hasContent: boolean): void {
    this.hasContent = hasContent;
  }

  /** True when there is a translation in progress worth protecting. */
  hasUnfinishedContent(): boolean {
    return this.hasContent;
  }

  /** Pinned windows keep their place and ignore blur. */
  setPinned(pinned: boolean): boolean {
    this.state.pinned = pinned;
    if (pinned) this.captureBounds();
    this.writeState();
    return this.state.pinned;
  }

  private ensureWindow(): void {
    if (this.win && !this.win.isDestroyed()) return;

    this.win = new BrowserWindow({
      width: this.state.width,
      height: this.state.height,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      movable: true,
      backgroundColor: "#1e1e2e",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    void this.win.loadFile(path.join(this.rendererDir, "translator.html"));

    // Hide on blur — but blur is not the same as "dismiss": see
    // shouldHideOnBlur in window-policy.ts (#166).
    this.win.on("blur", () => {
      if (shouldHideOnBlur({ pinned: this.state.pinned, hasContent: this.hasContent })) {
        this.hide();
      }
    });

    // Persist whatever the user dragged/resized to, so the next open matches.
    this.win.on("resize", () => this.captureBoundsDebounced());
    this.win.on("move", () => this.captureBoundsDebounced());

    this.win.on("closed", () => {
      this.win = null;
    });
  }

  /**
   * Pinned: leave the window exactly where the user put it. Unpinned: follow
   * the cursor, keeping the remembered size.
   */
  private place(): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.state.pinned) {
      if (this.state.x !== null && this.state.y !== null) {
        this.win.setBounds({
          x: this.state.x,
          y: this.state.y,
          width: this.state.width,
          height: this.state.height
        });
      }
      return;
    }
    this.positionNearCursor();
  }

  private positionNearCursor(): void {
    if (!this.win || this.win.isDestroyed()) return;

    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { bounds } = display;
    const { width, height } = this.state;

    let x = cursor.x + CURSOR_OFFSET;
    let y = cursor.y + CURSOR_OFFSET;

    // Clamp so the window doesn't go off-screen
    if (x + width > bounds.x + bounds.width) {
      x = cursor.x - width - CURSOR_OFFSET;
    }
    if (y + height > bounds.y + bounds.height) {
      y = cursor.y - height - CURSOR_OFFSET;
    }
    x = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - width));
    y = Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - height));

    this.win.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  }

  private boundsTimer: NodeJS.Timeout | null = null;

  /** Drag/resize fire continuously — write once the gesture settles. */
  private captureBoundsDebounced(): void {
    if (this.boundsTimer) clearTimeout(this.boundsTimer);
    this.boundsTimer = setTimeout(() => {
      this.boundsTimer = null;
      this.captureBounds();
      this.writeState();
    }, 400);
  }

  private captureBounds(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    const bounds = this.win.getBounds();
    this.state.width = Math.max(MIN_WIDTH, bounds.width);
    this.state.height = Math.max(MIN_HEIGHT, bounds.height);
    this.state.x = bounds.x;
    this.state.y = bounds.y;
  }

  private readState(): TranslatorWindowState {
    const fallback: TranslatorWindowState = {
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      x: null,
      y: null,
      pinned: false
    };
    if (!this.statePath) return fallback;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Partial<TranslatorWindowState>;
      return {
        width: clampSize(parsed.width, DEFAULT_WIDTH, MIN_WIDTH),
        height: clampSize(parsed.height, DEFAULT_HEIGHT, MIN_HEIGHT),
        x: Number.isFinite(parsed.x) ? (parsed.x as number) : null,
        y: Number.isFinite(parsed.y) ? (parsed.y as number) : null,
        pinned: parsed.pinned === true
      };
    } catch {
      return fallback;
    }
  }

  private writeState(): void {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
    } catch (err) {
      console.warn("[marshal] failed to persist translator window state:", err);
    }
  }
}

function clampSize(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? Math.round(value) : fallback;
}
