// desktop/capture/floating-toolbar.ts
//
// A small, always-on-top window with one-click access to area / fullscreen /
// record / GIF / history actions. Designed to live unobtrusively at the edge
// of the screen — frameless, drag-enabled, no traffic lights.
//
// The window is purely a launcher: every button maps to an IPC channel that
// already exists on the main process (the same handlers the tray and global
// shortcuts use). No new business logic lives here.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, screen } from "electron";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const rendererDir = path.join(desktopDistDir, "..", "renderer");

const TOOLBAR_WIDTH = 340;
const TOOLBAR_HEIGHT = 48;

export class FloatingToolbar {
  private window: BrowserWindow | null = null;
  private readonly preloadPath: string;

  constructor(preloadPath: string) {
    this.preloadPath = preloadPath;
  }

  isOpen(): boolean {
    return Boolean(this.window && !this.window.isDestroyed());
  }

  toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  open(): void {
    if (this.isOpen()) {
      this.window?.focus();
      return;
    }

    const display = screen.getPrimaryDisplay();
    const { x, y, width: dw } = display.workArea;
    // Park the toolbar in the top-right of the primary display by default.
    // The user can drag it anywhere; Electron remembers position only within
    // the running app lifetime — persistence is out of scope for v1.
    const winX = x + dw - TOOLBAR_WIDTH - 16;
    const winY = y + 16;

    this.window = new BrowserWindow({
      width: TOOLBAR_WIDTH,
      height: TOOLBAR_HEIGHT,
      x: winX,
      y: winY,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      // hasShadow gives the floating panel a real drop shadow against the
      // desktop background. Without it the rounded corners look pasted-on.
      hasShadow: true,
      skipTaskbar: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    // setVisibleOnAllWorkspaces is the durable form — the constructor option
    // only sets the initial state. Re-apply with `visibleOnFullScreen: true`
    // so we follow the user into fullscreen.
    if (process.platform === "darwin") {
      this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      // "screen-saver" floats above almost everything; "floating" alone would
      // sit under fullscreen apps' menu bar overlay.
      this.window.setAlwaysOnTop(true, "screen-saver");
    }

    this.window.on("closed", () => {
      this.window = null;
    });

    void this.window.loadFile(path.join(rendererDir, "floating-toolbar.html"));
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
  }
}
