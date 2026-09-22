// desktop/translator/screenshot-service.ts
// Captures the full screen (see capture/display-capture.ts), then shows a crop overlay.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain, screen, systemPreferences } from "electron";
import type { Display } from "electron";

import { captureDisplay } from "../capture/display-capture.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);

export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

export class ScreenshotService {
  private cropWindow: BrowserWindow | null = null;
  private preloadPath: string;
  private rendererDir: string;

  constructor(preloadPath: string) {
    this.preloadPath = preloadPath;
    // screenshot-service.ts compiles to dist/desktop/translator/, so go up one level
    this.rendererDir = path.join(desktopDistDir, "..", "renderer");
  }

  /**
   * Captures the full screen as base64 PNG, then opens a crop overlay.
   * Returns the cropped region as base64 PNG, or null if cancelled.
   */
  async captureWithCrop(): Promise<string | null> {
    this.assertScreenRecordingGranted();
    const display = screen.getPrimaryDisplay();
    const { image: thumbnail, scaleFactor } = await captureDisplay(display);

    // Open crop overlay and wait for region selection
    const region = await this.openCropOverlay(thumbnail.toDataURL(), display);
    if (!region) return null;

    // Crop the nativeImage
    const cropped = thumbnail.crop({
      x: Math.round(region.x * scaleFactor),
      y: Math.round(region.y * scaleFactor),
      width: Math.round(region.width * scaleFactor),
      height: Math.round(region.height * scaleFactor)
    });

    // Return base64 without the data URL prefix
    const dataUrl = cropped.toDataURL();
    return dataUrl.replace(/^data:image\/\w+;base64,/u, "");
  }

  /**
   * Same crop overlay, but the result is the chosen rectangle (DIP, primary
   * display) rather than its pixels. Live captions remember it and capture
   * it again later without showing any UI.
   */
  async pickRegion(): Promise<CropRegion | null> {
    this.assertScreenRecordingGranted();
    const display = screen.getPrimaryDisplay();
    const { image } = await captureDisplay(display);
    return this.openCropOverlay(image.toDataURL(), display);
  }

  private assertScreenRecordingGranted(): void {
    // Check Screen Recording permission before attempting capture.
    // On macOS, without permission the capture silently comes back blank.
    if (process.platform !== "darwin") return;
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status !== "granted") {
      throw new Error(
        "Screen Recording permission required.\n" +
        "Open System Settings → Privacy & Security → Screen Recording\n" +
        "and enable Marshal, then restart the app."
      );
    }
  }

  private openCropOverlay(screenshotDataUrl: string, display: Display): Promise<CropRegion | null> {
    const { width, height } = display.bounds;
    return new Promise((resolve) => {
      const { x, y } = display.bounds;
      // Per-invocation unique ipc channels prevent two concurrent overlays
      // (e.g. hotkey + toolbar button fired in quick succession) from
      // cross-firing each other's crop-selected / crop-cancelled events.
      const token = randomUUID();
      const selectChannel = `marshal:crop-selected:${token}`;
      const cancelChannel = `marshal:crop-cancelled:${token}`;

      this.cropWindow = new BrowserWindow({
        // Cover the entire display without using fullscreen mode.
        // setFullScreen(true) breaks transparency on macOS — avoid it.
        width,
        height,
        x,
        y,
        frame: false,
        transparent: true,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        focusable: true,
        webPreferences: {
          preload: this.preloadPath,
          contextIsolation: true,
          nodeIntegration: false
        }
      });

      // screen-saver level puts the window above the macOS menu bar
      this.cropWindow.setAlwaysOnTop(true, "screen-saver");
      this.cropWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      // Do NOT call setFullScreen(true) — it enters a separate macOS Space
      // and breaks window transparency, resulting in a black overlay.

      void this.cropWindow.loadFile(path.join(this.rendererDir, "crop-overlay.html"));

      // Send overlay init (channel names + legacy dataUrl) once ready.
      this.cropWindow.webContents.on("did-finish-load", () => {
        this.cropWindow?.webContents.send("crop-init", {
          dataUrl: screenshotDataUrl,
          channels: { select: selectChannel, cancel: cancelChannel }
        });
      });

      // Receive selected region from renderer
      const onRegion = (_event: Electron.IpcMainEvent, region: CropRegion) => {
        cleanup();
        resolve(region);
      };

      const onCancel = (): void => {
        cleanup();
        resolve(null);
      };

      ipcMain.once(selectChannel, onRegion);
      ipcMain.once(cancelChannel, onCancel);

      this.cropWindow.on("closed", () => {
        ipcMain.removeListener(selectChannel, onRegion);
        ipcMain.removeListener(cancelChannel, onCancel);
        resolve(null);
      });

      const cleanup = (): void => {
        ipcMain.removeListener(selectChannel, onRegion);
        ipcMain.removeListener(cancelChannel, onCancel);
        if (this.cropWindow && !this.cropWindow.isDestroyed()) {
          this.cropWindow.close();
        }
        this.cropWindow = null;
      };
    });
  }
}
