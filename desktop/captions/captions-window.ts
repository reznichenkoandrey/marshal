// desktop/captions/captions-window.ts
//
// The subtitles overlay. Three properties make it what the spec calls a
// "local-only privacy overlay":
//
//   • `setContentProtection(true)` — on macOS this sets the NSWindow's
//     sharingType to .none, so ScreenCaptureKit (Zoom, Meet, OBS, QuickTime)
//     never sees it; on Windows the same call is WDA_EXCLUDEFROMCAPTURE.
//   • `setIgnoreMouseEvents(true, { forward: true })` — clicks land on
//     whatever is underneath, so the overlay can sit over a call or an editor
//     without stealing focus. Mouse moves still reach the renderer, and the
//     header bar takes the mouse while the pointer is over it: that is where
//     the stop button and the drag handle live (#351, #352). Holding the drag
//     modifier or tray → Move Overlay makes the whole window take it.
//   • `type: "panel"` + always-on-top at screen-saver level, visible on every
//     Space including full-screen apps — a caption box that disappears when
//     the call goes full screen is useless.
//
// Position is remembered across runs. Marshal is an LSUIElement app, so a
// window that gets lost has no Dock icon to bring it back (#168); this one is
// floating anyway, and the tray can reset it to the default spot.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, screen } from "electron";

import {
  OVERLAY_DEFAULT_HEIGHT,
  OVERLAY_DEFAULT_WIDTH,
  OVERLAY_MIN_HEIGHT,
  OVERLAY_MIN_WIDTH,
  resolveOverlayBounds,
  upgradeSavedSize,
  type OverlayBoundsState,
  type OverlayUpdate
} from "./overlay-layout.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const rendererDir = path.join(desktopDistDir, "..", "renderer");
const STATE_FILE = "captions-overlay-state.json";

export interface OcrRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CaptionsWindowState extends OverlayBoundsState {
  ocrRegion: OcrRegion | null;
}

export class CaptionsWindow {
  private win: BrowserWindow | null = null;
  private readonly preloadPath: string;
  private readonly statePath: string | null;
  private state: CaptionsWindowState;
  private interactive = false;
  private barHovered = false;
  private drag: { pointerX: number; pointerY: number; windowX: number; windowY: number } | null = null;
  private lastUpdate: OverlayUpdate | null = null;
  private boundsTimer: NodeJS.Timeout | null = null;

  constructor(preloadPath: string, userDataDir?: string) {
    this.preloadPath = preloadPath;
    this.statePath = userDataDir ? path.join(userDataDir, STATE_FILE) : null;
    this.state = this.readState();
  }

  show(): void {
    this.ensureWindow();
    const win = this.win!;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    win.setBounds(resolveOverlayBounds(this.state, display.workArea));
    win.showInactive();
    if (this.lastUpdate) this.update(this.lastUpdate);
  }

  hide(): void {
    this.barHovered = false;
    this.drag = null;
    if (this.win && !this.win.isDestroyed()) {
      this.captureBounds();
      this.writeState();
      this.win.hide();
    }
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.captureBounds();
      this.writeState();
      this.win.close();
    }
    this.win = null;
  }

  isVisible(): boolean {
    return !!(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  /** Pushes fresh content; safe to call before the renderer has loaded. */
  update(update: OverlayUpdate): void {
    this.lastUpdate = { ...update, interactive: this.interactive };
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.webContents.isLoading()) return;
    this.win.webContents.send("marshal:captions-update", this.lastUpdate);
  }

  /** Move mode: the whole window takes the mouse, not just the header bar. */
  setInteractive(interactive: boolean): void {
    this.interactive = interactive;
    this.applyMouse();
    if (this.lastUpdate) this.update(this.lastUpdate);
  }

  isInteractive(): boolean {
    return this.interactive;
  }

  /** Forget the saved position; the next show() centres it at the bottom again. */
  resetPosition(): void {
    this.state.x = null;
    this.state.y = null;
    this.state.width = OVERLAY_DEFAULT_WIDTH;
    this.state.height = OVERLAY_DEFAULT_HEIGHT;
    this.writeState();
    if (this.isVisible()) this.show();
  }

  /**
   * Hides the overlay for the duration of `capture` so a screenshot of the
   * workspace never contains the captions. Content protection already keeps
   * it out of ScreenCaptureKit, but the spec asks for it explicitly and
   * desktopCapturer thumbnails are a different path.
   */
  async withHidden<T>(capture: () => Promise<T>): Promise<T> {
    const wasVisible = this.isVisible();
    if (wasVisible) {
      this.win!.hide();
      // One frame for the compositor to actually drop the window.
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
    }
    try {
      return await capture();
    } finally {
      if (wasVisible && this.win && !this.win.isDestroyed()) this.win.showInactive();
    }
  }

  getOcrRegion(): OcrRegion | null {
    return this.state.ocrRegion;
  }

  setOcrRegion(region: OcrRegion | null): void {
    this.state.ocrRegion = region;
    this.writeState();
  }

  private ensureWindow(): void {
    if (this.win && !this.win.isDestroyed()) return;

    this.win = new BrowserWindow({
      width: this.state.width,
      height: this.state.height,
      minWidth: OVERLAY_MIN_WIDTH,
      minHeight: OVERLAY_MIN_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      movable: true,
      focusable: false,
      // NSPanel on macOS: floats above regular windows without taking key
      // status, which is also what keeps it out of Cmd+Tab.
      type: process.platform === "darwin" ? "panel" : undefined,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    const win = this.win;
    // The privacy property. Must be set before the window is shown.
    win.setContentProtection(true);
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.applyMouse();
    // Scoped to this window's renderer: no other page can move it.
    win.webContents.ipc.on("marshal:captions-pointer", (_event, message: unknown) => this.onPointer(message));

    win.on("resize", () => this.captureBoundsDebounced());
    win.on("move", () => this.captureBoundsDebounced());
    win.on("closed", () => {
      this.win = null;
    });
    win.webContents.once("did-finish-load", () => {
      if (this.lastUpdate) win.webContents.send("marshal:captions-update", this.lastUpdate);
    });

    void win.loadFile(path.join(rendererDir, "captions-overlay.html"));
  }

  private applyMouse(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const accept = this.interactive || this.barHovered || this.drag !== null;
    this.win.setIgnoreMouseEvents(!accept, { forward: true });
  }

  /**
   * The renderer moves the window from its own pointer events.
   * `-webkit-app-region: drag` did not move this non-focusable panel, while
   * the native resize edges worked (#351).
   */
  private onPointer(message: unknown): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !message || typeof message !== "object") return;
    const { type, screenX, screenY, hovered } = message as Record<string, unknown>;
    const hasPoint = Number.isFinite(screenX) && Number.isFinite(screenY);
    if (type === "hover") {
      this.barHovered = hovered === true;
      this.applyMouse();
    } else if (type === "drag-start" && hasPoint) {
      const [windowX, windowY] = win.getPosition();
      this.drag = { pointerX: screenX as number, pointerY: screenY as number, windowX, windowY };
      this.applyMouse();
    } else if (type === "drag-move" && hasPoint && this.drag) {
      win.setPosition(
        Math.round(this.drag.windowX + (screenX as number) - this.drag.pointerX),
        Math.round(this.drag.windowY + (screenY as number) - this.drag.pointerY)
      );
    } else if (type === "drag-end") {
      this.drag = null;
      this.applyMouse();
    }
  }

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
    this.state.width = Math.max(OVERLAY_MIN_WIDTH, bounds.width);
    this.state.height = Math.max(OVERLAY_MIN_HEIGHT, bounds.height);
    this.state.x = bounds.x;
    this.state.y = bounds.y;
  }

  private readState(): CaptionsWindowState {
    const fallback: CaptionsWindowState = {
      width: OVERLAY_DEFAULT_WIDTH,
      height: OVERLAY_DEFAULT_HEIGHT,
      x: null,
      y: null,
      ocrRegion: null
    };
    if (!this.statePath) return fallback;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Partial<CaptionsWindowState>;
      return {
        ...upgradeSavedSize({
          width: clampSize(parsed.width, OVERLAY_DEFAULT_WIDTH, OVERLAY_MIN_WIDTH),
          height: clampSize(parsed.height, OVERLAY_DEFAULT_HEIGHT, OVERLAY_MIN_HEIGHT)
        }),
        x: typeof parsed.x === "number" && Number.isFinite(parsed.x) ? parsed.x : null,
        y: typeof parsed.y === "number" && Number.isFinite(parsed.y) ? parsed.y : null,
        ocrRegion: isRegion(parsed.ocrRegion) ? parsed.ocrRegion : null
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
      console.warn("[captions] failed to persist overlay state:", err);
    }
  }
}

function clampSize(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? Math.round(value) : fallback;
}

function isRegion(value: unknown): value is OcrRegion {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every(
    (key) => typeof rect[key] === "number" && Number.isFinite(rect[key] as number)
  ) && (rect.width as number) > 0 && (rect.height as number) > 0;
}
