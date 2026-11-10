// Assistant home window (#284): the HUD voice visual and the dock. Created on
// open and destroyed on close, so no renderer — and no animation — lives on
// while nobody looks at it (#281). Floating because Marshal is LSUIElement: a
// plain window that falls behind another app has no way back (#168).

import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, screen } from "electron";

import type { ReminderLanguage } from "../calendar/reminders.ts";
import type { AssistantState, SessionGroup } from "./assistant-state.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const rendererDir = path.join(path.dirname(currentFilePath), "..", "renderer");

const WIDTH = 920;
const HEIGHT = 600;

export type AssistantStrip = {
  active: { dictation: boolean; captions: boolean; translator: boolean; recording: boolean };
  speech: boolean;
  badge: boolean;
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

  constructor(
    private readonly preloadPath: string,
    // Main keeps watchers (sessions directory) alive only while this is open.
    private readonly onOpenChange: (open: boolean) => void = () => {}
  ) {}

  isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  toggle(): void {
    if (this.isOpen() && this.window?.isVisible()) this.close();
    else this.open();
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
      minWidth: 460,
      minHeight: 480,
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      y: Math.round(area.y + (area.height - HEIGHT) / 2),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: true,
      resizable: true,
      fullscreenable: false,
      alwaysOnTop: true,
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
      app.focus({ steal: true });
      this.window?.show();
      this.window?.focus();
    });
    void this.window.loadFile(path.join(rendererDir, "assistant-home.html"));
    this.onOpenChange(true);
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
