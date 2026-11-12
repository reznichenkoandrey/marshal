// Assistant home window (#284): the HUD voice visual and the dock. Created on
// open and destroyed on close, so no renderer — and no animation — lives on
// while nobody looks at it (#281). Not floating (#336): it falls behind the
// app the user clicks, and the tray icon or the hotkey bring it back — the
// way back an LSUIElement window needs (#168).

import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, screen } from "electron";

import type { ReminderLanguage } from "../calendar/reminders.ts";
import type { AssistantState, SessionGroup } from "./assistant-state.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const rendererDir = path.join(path.dirname(currentFilePath), "..", "renderer");

const WIDTH = 1100;
const HEIGHT = 720;

export type AssistantStrip = {
  active: { dictation: boolean; captions: boolean; translator: boolean; recording: boolean };
  speech: boolean;
  /** null until the one measurement taken on open finishes, or when it failed. */
  memory: { usedMb: number; budgetMb: number } | null;
  meeting: { title: string; start: string; joinable: boolean } | null;
  hotkey: string | null;
};

export type AssistantView = {
  state: AssistantState;
  lang: ReminderLanguage;
  strip?: AssistantStrip;
  // What Marshal last said or notified, newest first (#308).
  lines?: string[];
  sessions?: SessionGroup[];
};

export class AssistantHomeWindow {
  private window: BrowserWindow | null = null;
  private view: AssistantView = { state: "idle", lang: "en" };
  // Settings asked for before the page loaded are shown once it has (#317).
  private settingsPending = false;

  constructor(
    private readonly preloadPath: string,
    // Main keeps watchers (sessions directory) alive only while this is open.
    private readonly onOpenChange: (open: boolean) => void = () => {}
  ) {}

  isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  owns(win: BrowserWindow): boolean {
    return win === this.window;
  }

  /** Open, shown and focused: a toggle closes it; anything less, a toggle raises it. */
  isInFront(): boolean {
    return this.isOpen() && (this.window?.isVisible() ?? false) && (this.window?.isFocused() ?? false);
  }

  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      app.focus({ steal: true });
      this.window.show();
      this.window.focus();
      return;
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    this.window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      minWidth: 520,
      minHeight: 560,
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      y: Math.round(area.y + (area.height - HEIGHT) / 2),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: true,
      resizable: true,
      fullscreenable: false,
      skipTaskbar: true,
      title: "Marshal",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    const created = this.window;
    created.on("closed", () => {
      // A window reopened before this one finished closing is not ours to clear.
      if (this.window !== created) return;
      this.window = null;
      this.onOpenChange(false);
    });
    this.window.webContents.once("did-finish-load", () => {
      this.push();
      if (this.settingsPending) created.webContents.send("marshal:assistant-show-settings");
      this.settingsPending = false;
      app.focus({ steal: true });
      this.window?.show();
      this.window?.focus();
    });
    void this.window.loadFile(path.join(rendererDir, "assistant-home.html"));
    this.onOpenChange(true);
  }

  /** Opens the window on its settings view; settings have no window of their own (#317). */
  showSettings(): void {
    const loading = !this.window || this.window.isDestroyed() || this.window.webContents.isLoading();
    this.open();
    if (loading) this.settingsPending = true;
    else this.window?.webContents.send("marshal:assistant-show-settings");
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close();
  }

  /** Keeps the latest view so a window opened later starts from it. */
  update(view: Partial<AssistantView>): void {
    this.view = { ...this.view, ...view };
    this.push();
  }

  private push(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("marshal:assistant-state", this.view);
  }
}
