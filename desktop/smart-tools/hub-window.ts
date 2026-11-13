// desktop/smart-tools/hub-window.ts
//
// The window that shows the smart-hub panel (#417). The only new UI in this
// repo: every pixel inside comes from the hub over loopback, so there is no
// markup here — just lifecycle, geometry and the token.
//
// The token rides as a request header on that origin, added in the window's own
// in-memory session. Same-origin fetches from the panel get it too, so the
// panel's /api/* calls work without a preload shim, and the token stays out of
// the title, the URL and the log.
//
// Marshal is an LSUIElement app: a plain window that ends up behind another
// cannot be raised by any system means (#168). The tray entry is the way back,
// which needs app.focus({ steal: true }) — BrowserWindow.focus() alone does
// nothing for an accessory app.

import fs from "node:fs";
import path from "node:path";

import { app, BrowserWindow, session, shell } from "electron";

import { clampWindowState, TOKEN_HEADER, type HubWindowState } from "./hub.ts";

const STATE_FILE = "smart-hub-window-state.json";
const DEFAULTS: HubWindowState = { width: 1100, height: 720, x: null, y: null };
const MIN = { width: 560, height: 400 };
const SAVE_DEBOUNCE_MS = 400;

export class SmartHubWindow {
  private win: BrowserWindow | null = null;
  private readonly statePath: string | null;
  private state: HubWindowState;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(userDataDir?: string) {
    this.statePath = userDataDir ? path.join(userDataDir, STATE_FILE) : null;
    this.state = this.readState();
  }

  open(url: string, token: string): void {
    const origin = new URL(url).origin;
    const partition = session.fromPartition("smart-hub");
    // Only one listener per session: re-registering picks up this run's port
    // and token, since both change whenever the hub restarts.
    partition.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, [TOKEN_HEADER]: token } });
    });

    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      app.focus({ steal: true });
      this.win.focus();
      if (this.win.webContents.getURL().startsWith(origin)) return;
      void this.win.loadURL(url);
      return;
    }

    this.win = new BrowserWindow({
      width: this.state.width,
      height: this.state.height,
      ...(this.state.x !== null && this.state.y !== null ? { x: this.state.x, y: this.state.y } : {}),
      minWidth: MIN.width,
      minHeight: MIN.height,
      show: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
      backgroundColor: "#131316",
      webPreferences: {
        session: partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    // The window holds a bearer token: keep it on the hub's own origin.
    this.win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (target.startsWith("https://")) void shell.openExternal(target);
      return { action: "deny" };
    });
    this.win.webContents.on("will-navigate", (event, target) => {
      if (target.startsWith(origin)) return;
      event.preventDefault();
      if (target.startsWith("https://")) void shell.openExternal(target);
    });

    this.win.on("resize", () => this.scheduleSave());
    this.win.on("move", () => this.scheduleSave());
    this.win.on("closed", () => {
      this.win = null;
    });

    this.win.webContents.once("did-finish-load", () => {
      this.win?.show();
      app.focus({ steal: true });
      this.win?.focus();
    });

    void this.win.loadURL(url);
  }

  isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.win && !this.win.isDestroyed()) {
      this.captureBounds();
      this.writeState();
      this.win.close();
    }
    this.win = null;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.captureBounds();
      this.writeState();
    }, SAVE_DEBOUNCE_MS);
  }

  private captureBounds(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    const bounds = this.win.getBounds();
    this.state = clampWindowState(bounds, DEFAULTS, MIN);
  }

  private readState(): HubWindowState {
    if (!this.statePath) return { ...DEFAULTS };
    try {
      return clampWindowState(JSON.parse(fs.readFileSync(this.statePath, "utf8")), DEFAULTS, MIN);
    } catch {
      return { ...DEFAULTS };
    }
  }

  private writeState(): void {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
    } catch (err) {
      console.warn("[smart-hub] failed to persist window state:", (err as Error).message);
    }
  }
}
