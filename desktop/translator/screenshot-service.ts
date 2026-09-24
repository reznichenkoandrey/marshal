// desktop/translator/screenshot-service.ts
// Captures the full screen (see capture/display-capture.ts), then shows a crop overlay.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, screen, systemPreferences } from "electron";
import type { Display } from "electron";

import { openCropOverlay } from "../capture/crop-overlay.ts";
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
    // One shared overlay for the capture studio, this OCR crop and the
    // live-captions region — including the macOS geometry fix it carries
    // (see capture/crop-overlay.ts and #223).
    return openCropOverlay({
      display,
      preloadPath: this.preloadPath,
      rendererDir: this.rendererDir,
      screenshotDataUrl,
      onWindow: (window) => {
        this.cropWindow = window;
      }
    }) as Promise<CropRegion | null>;
  }
}
