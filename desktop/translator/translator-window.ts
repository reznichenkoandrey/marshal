// desktop/translator/translator-window.ts
// Manages the floating translator BrowserWindow lifecycle.
//
// Results of the hotkeys (double ⌘C, ⌘⌥T) and of ⌘⇧2 open a compact popup
// next to the cursor — the translation and its actions, sized to the text, as
// in DeepL (#344). Expand turns it into the full window below.
//
// Two modes of the full window, mirroring how a desktop translator is used:
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
// A hidden, empty window is kept this long for a fast reopen, then destroyed:
// a renderer kept forever counts against the idle budget (#281, #350).
const RELEASE_HIDDEN_MS = 10 * 60_000;
const COMPACT_WIDTH = 420;
const COMPACT_INITIAL_HEIGHT = 150;
const COMPACT_MIN_HEIGHT = 96;
const COMPACT_MAX_HEIGHT = 440;

export type TranslatorView = "full" | "compact";

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
  private releaseTimer: NodeJS.Timeout | null = null;
  private view: TranslatorView = "full";
  /** Resolves once the page can receive IPC; sends before that are lost. */
  private ready: Promise<void> = Promise.resolve();

  constructor(preloadPath: string, userDataDir?: string) {
    this.preloadPath = preloadPath;
    // translator-window.ts compiles to dist/desktop/translator/, so go up one level
    this.rendererDir = path.join(desktopDistDir, "..", "renderer");
    this.statePath = userDataDir ? path.join(userDataDir, STATE_FILE) : null;
    this.state = this.readState();
  }

  /** Opens the full window in empty state (tray, home, ⌘⌥T on an empty clipboard). */
  show(): void {
    this.ensureWindow();
    this.setView("full");
    this.place();
    this.win!.show();
    this.win!.focus();
  }

  /** Fills the window with a hotkey result. Opens the popup if nothing is open. */
  showWithText(text: string, translation: string, sourceLang: string, targetLang: string): void {
    this.openForResult();
    this.send("translator-result", { text, translation, sourceLang, targetLang, mode: "text" });
  }

  /** Shows a translation-in-progress spinner for a hotkey or OCR request. */
  showLoading(mode: "text" | "image" = "text"): void {
    this.openForResult();
    this.send("translator-loading", { mode });
  }

  /** Sends an error state to the renderer, opening the popup if nothing is open. */
  showError(message: string): void {
    if (!this.isVisible()) this.openForResult();
    this.send("translator-error", { message });
  }

  /** Popup → full window, keeping its top-left corner where the popup was. */
  expand(): void {
    if (!this.win || this.win.isDestroyed() || this.view === "full") return;
    const popup = this.win.getBounds();
    this.setView("full");
    const area = screen.getDisplayMatching(popup).workArea;
    const { width, height } = this.state;
    const x = Math.max(area.x, Math.min(popup.x, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(popup.y, area.y + area.height - height));
    this.win.setBounds({ x, y, width, height });
    this.win.focus();
  }

  /** The popup reports how tall its content is; grow or shrink to it. */
  fitCompact(contentHeight: number): void {
    if (!this.win || this.win.isDestroyed() || this.view !== "compact") return;
    if (!Number.isFinite(contentHeight)) return;
    const height = Math.round(Math.max(COMPACT_MIN_HEIGHT, Math.min(contentHeight, COMPACT_MAX_HEIGHT)));
    const bounds = this.win.getBounds();
    if (bounds.height === height) return;
    const area = screen.getDisplayMatching(bounds).workArea;
    const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - height));
    this.win.setBounds({ x: bounds.x, y, width: bounds.width, height });
  }

  /**
   * A non-blocking note in the translator window. Used when the service had
   * to swap backends behind the user's back (#160) — without it the only
   * symptom is that translation suddenly takes ten seconds.
   */
  showNotice(message: string): void {
    this.send("translator-notice", { message });
  }

  /** Sends translation result for image mode. */
  showImageResult(result: { translation: string; targetLang: string; sourceLang: string; sourceText?: string }): void {
    this.send("translator-result", { ...result, mode: "image" });
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.captureBounds();
      this.win.hide();
      this.scheduleRelease();
    }
  }

  private scheduleRelease(): void {
    this.cancelRelease();
    if (this.hasContent) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (this.win && !this.win.isDestroyed() && !this.win.isVisible() && !this.hasContent) this.win.destroy();
    }, RELEASE_HIDDEN_MS);
    this.releaseTimer.unref();
  }

  private cancelRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
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

  /**
   * Hotkey and OCR results go to the compact popup — unless the full window
   * is already on screen, in which case the user is working in it and the
   * result lands there. Pinned alone does not count: it is persisted, and a
   * closed pinned window would otherwise take over every popup (#348).
   */
  private openForResult(): void {
    this.ensureWindow();
    if (!(this.isVisible() && this.view === "full")) {
      this.setView("compact");
      this.positionNearCursor(COMPACT_WIDTH, COMPACT_INITIAL_HEIGHT);
    }
    this.win!.show();
    this.win!.focus();
  }

  private setView(view: TranslatorView): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.view = view;
    if (view === "compact") {
      this.win.setMinimumSize(COMPACT_WIDTH, COMPACT_MIN_HEIGHT);
      this.win.setResizable(false);
    } else {
      this.win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
      this.win.setResizable(true);
    }
    this.send("translator-view", { view });
  }

  private send(channel: string, payload: unknown): void {
    void this.ready.then(() => {
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
    });
  }

  private ensureWindow(): void {
    this.cancelRelease();
    if (this.win && !this.win.isDestroyed()) return;
    this.hasContent = false;

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

    const win = this.win;
    this.ready = new Promise<void>((resolve) => {
      win.webContents.once("did-finish-load", () => resolve());
    });
    void win.loadFile(path.join(this.rendererDir, "translator.html"));

    // Hide on blur — but blur is not the same as "dismiss": see
    // shouldHideOnBlur in window-policy.ts (#166). The popup is a glance: it
    // always goes, and the translation stays in history.
    this.win.on("blur", () => {
      if (shouldHideOnBlur({ pinned: this.state.pinned, hasContent: this.hasContent, compact: this.view === "compact" })) {
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
    this.positionNearCursor(this.state.width, this.state.height);
  }

  private positionNearCursor(width: number, height: number): void {
    if (!this.win || this.win.isDestroyed()) return;

    const cursor = screen.getCursorScreenPoint();
    const bounds = screen.getDisplayNearestPoint(cursor).workArea;

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
    // The popup's size is not the size the full window should come back at.
    if (this.view === "compact") return;
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
