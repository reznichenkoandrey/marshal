// Ambient indicators (#285). Both windows are created when they show and
// destroyed when they hide: no renderer lives on while there is nothing to
// show (#281). Both are excluded from screen sharing (setContentProtection,
// as the captions overlay): the frame is a private signal, and the widget
// lists Claude Code session names.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, screen, type BrowserWindowConstructorOptions } from "electron";

import type { ReminderLanguage } from "../calendar/reminders.ts";
import type { AssistantState } from "./assistant-state.ts";
import { WIDGET_WIDTH, resolveWidgetPosition, widgetHeight, type GlowState, type Point, type WidgetCard } from "./ambient.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const rendererDir = path.join(path.dirname(currentFilePath), "..", "renderer");
const STATE_CHANNEL = "marshal:assistant-state";

function floatingPanel(preloadPath: string, extra: BrowserWindowConstructorOptions): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    fullscreenable: false,
    // Never key: dictation pastes into whatever app the user is in (#243).
    focusable: false,
    type: process.platform === "darwin" ? "panel" : undefined,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false },
    ...extra
  });
  window.setAlwaysOnTop(true, "screen-saver");
  // Without skipTransformProcessType Electron turns Marshal into a foreground
  // app and the next dictation types into nothing (#243).
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  window.setContentProtection(true);
  return window;
}

/** Soft state-coloured light along the edges of the display the user is on. */
export class GlowFrame {
  private window: BrowserWindow | null = null;
  private state: GlowState | null = null;

  constructor(private readonly preloadPath: string) {}

  isShown(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  set(state: GlowState | null): void {
    if (state === this.state) return;
    this.state = state;
    if (!state) {
      if (this.isShown()) this.window?.destroy();
      this.window = null;
      return;
    }
    if (this.isShown()) {
      this.push();
      return;
    }
    const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // Full display bounds: without enableLargerThanScreen Cocoa pushes the
    // window below the menu bar and the top edge would glow 25 pt too low (#223).
    const window = floatingPanel(this.preloadPath, { ...bounds, movable: false, enableLargerThanScreen: true });
    window.setIgnoreMouseEvents(true);
    this.window = window;
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
    window.webContents.once("did-finish-load", () => {
      if (this.window !== window) return;
      window.setBounds(bounds);
      this.push();
      window.showInactive();
    });
    void window.loadFile(path.join(rendererDir, "assistant-glow.html"));
  }

  private push(): void {
    if (this.state && this.isShown()) this.window?.webContents.send(STATE_CHANNEL, { state: this.state });
  }
}

export type WidgetView = { state: AssistantState; lang: ReminderLanguage; cards: WidgetCard[] };

/** Small voice visual docked at a screen edge, with "session X needs you" cards. */
export class MiniWidget {
  private window: BrowserWindow | null = null;
  private view: WidgetView = { state: "idle", lang: "en", cards: [] };

  constructor(
    private readonly preloadPath: string,
    private readonly position: { load: () => Point | null; save: (point: Point) => void },
    // Main keeps the sessions watcher alive only while something shows sessions.
    private readonly onOpenChange: (open: boolean) => void = () => {}
  ) {}

  isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  open(): void {
    if (this.isOpen()) return;
    const height = widgetHeight(this.view.cards.length);
    const { x, y } = this.place(this.position.load(), height);
    const window = floatingPanel(this.preloadPath, { x, y, width: WIDGET_WIDTH, height });
    this.window = window;
    window.on("closed", () => {
      if (this.window !== window) return;
      this.window = null;
      this.onOpenChange(false);
    });
    window.webContents.once("did-finish-load", () => {
      this.push();
      window.showInactive();
    });
    void window.loadFile(path.join(rendererDir, "assistant-widget.html"));
    this.onOpenChange(true);
  }

  close(): void {
    if (this.isOpen()) this.window?.close();
  }

  update(view: Partial<WidgetView>): void {
    const cardsBefore = this.view.cards.length;
    this.view = { ...this.view, ...view };
    if (this.isOpen() && this.view.cards.length !== cardsBefore) this.fit();
    this.push();
  }

  /** Drag from the renderer: follows the pointer, settles on a display and is remembered on release. */
  moveTo(point: Point, done: boolean): void {
    if (!this.isOpen() || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const window = this.window!;
    window.setPosition(Math.round(point.x), Math.round(point.y));
    if (!done) return;
    this.fit();
    const [x, y] = window.getPosition();
    this.position.save({ x, y });
  }

  private fit(): void {
    const window = this.window!;
    const [x, y] = window.getPosition();
    const height = widgetHeight(this.view.cards.length);
    window.setBounds({ ...this.place({ x, y }, height), width: WIDGET_WIDTH, height });
  }

  private place(saved: Point | null, height: number): Point {
    const areas = screen.getAllDisplays().map((display) => display.workArea);
    return resolveWidgetPosition(saved, areas, screen.getPrimaryDisplay().workArea, height);
  }

  private push(): void {
    if (this.isOpen()) this.window?.webContents.send(STATE_CHANNEL, this.view);
  }
}
