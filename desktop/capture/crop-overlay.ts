// desktop/capture/crop-overlay.ts
//
// The one place that builds the transparent full-display window the user drags
// a selection in. Three features need it — the capture studio's area picker,
// the translator's OCR crop, and the live-captions OCR region — and all three
// used to construct it themselves.
//
// The duplication was not cosmetic: it multiplied #223 by three. Cocoa
// constrains an ordinary window to the *visible* frame, so a window asked for
// at the display origin lands below the menu bar instead:
//
//   asked for           {"x":0,"y":0,   "width":1800,"height":1169}
//   got                 {"x":0,"y":39,  "width":1800,"height":1169}
//
// `setBounds` afterwards does not help — Cocoa re-applies the constraint. Two
// separate defects came out of that 39-point shift:
//
//   1. The overlay's `clientY` was 39 points short of the screen Y under the
//      pointer, so the crop sliced a rectangle from *above* the one drawn.
//   2. The bottom 39 points of the overlay hung off the screen, so a selection
//      reaching the lower edge asked for `y + height > image.height` and
//      `nativeImage.crop()` clamped it — the returned PNG came back shorter
//      than the rectangle the user drew.
//
// `enableLargerThanScreen: true` opts the window out of that constraint and it
// opens at the display origin, which is what every coordinate downstream
// assumes. Measured, not inferred; the e2e check in
// tests/e2e/capture-region.mjs asserts it against a real Electron runtime.
//
// The window level is "screen-saver" rather than "floating" for the same
// reason: it has to sit above the menu bar it now overlaps.

import path from "node:path";
import { randomUUID } from "node:crypto";

import { BrowserWindow, ipcMain, type Display } from "electron";

export interface CropSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropOverlayOptions {
  /** Display to cover — the overlay matches its bounds exactly. */
  display: Display;
  /** Absolute path to the Electron preload script. */
  preloadPath: string;
  /** Directory holding the compiled renderer assets. */
  rendererDir: string;
  /** Full-display PNG as a data URL; older overlay payloads still read it. */
  screenshotDataUrl: string;
  /** Called with the live window so a caller can keep its own reference. */
  onWindow?: (window: BrowserWindow | null) => void;
}

/**
 * Opens the crop overlay on `display` and resolves with the rectangle the user
 * drew, in CSS pixels relative to that display's origin. Resolves null when
 * the user pressed Esc or the drag was too small to be a selection.
 */
export function openCropOverlay(opts: CropOverlayOptions): Promise<CropSelection | null> {
  const { x, y, width, height } = opts.display.bounds;

  return new Promise((resolve) => {
    // Per-invocation channels keep two overlays opened in quick succession
    // (hotkey plus toolbar click) from consuming each other's events.
    const token = randomUUID();
    const selectChannel = `marshal:crop-selected:${token}`;
    const cancelChannel = `marshal:crop-cancelled:${token}`;

    const cropWindow = new BrowserWindow({
      // Cover the whole display without fullscreen mode: setFullScreen(true)
      // moves the window into its own macOS Space and kills transparency,
      // which renders the overlay as a solid black sheet.
      width,
      height,
      x,
      y,
      // Without this Cocoa clamps the window to the visible frame and shifts
      // it below the menu bar, which offsets every selection (#223).
      enableLargerThanScreen: true,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: true,
      webPreferences: {
        preload: opts.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    opts.onWindow?.(cropWindow);

    // screen-saver level clears the menu bar the overlay now covers.
    cropWindow.setAlwaysOnTop(true, "screen-saver");
    cropWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    void cropWindow.loadFile(path.join(opts.rendererDir, "crop-overlay.html"));

    cropWindow.webContents.on("did-finish-load", () => {
      if (cropWindow.isDestroyed()) return;
      cropWindow.webContents.send("crop-init", {
        dataUrl: opts.screenshotDataUrl,
        channels: { select: selectChannel, cancel: cancelChannel }
      });
    });

    const detach = (): void => {
      ipcMain.removeListener(selectChannel, onRegion);
      ipcMain.removeListener(cancelChannel, onCancel);
    };

    const cleanup = (): void => {
      detach();
      if (!cropWindow.isDestroyed()) cropWindow.close();
      opts.onWindow?.(null);
    };

    const onRegion = (_event: Electron.IpcMainEvent, region: CropSelection): void => {
      cleanup();
      resolve(region);
    };

    const onCancel = (): void => {
      cleanup();
      resolve(null);
    };

    ipcMain.once(selectChannel, onRegion);
    ipcMain.once(cancelChannel, onCancel);

    cropWindow.on("closed", () => {
      detach();
      opts.onWindow?.(null);
      resolve(null);
    });
  });
}
