// desktop/capture/capture-window.ts
//
// Annotation editor window: opens a frameless BrowserWindow sized to fit the
// captured image (clamped to the display), loads renderer/capture-editor.html,
// and pushes the captured PNG into it via IPC once the window is ready.
//
// The editor renderer handles all drawing + user interactions (crop, rect,
// arrow, text, etc.) and calls back into main through `marshalCapture:*`
// channels for save / copy / close.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, screen } from "electron";

import type { CaptureResult } from "./capture-service.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const rendererDir = path.join(desktopDistDir, "..", "renderer");

export interface OpenEditorOptions {
  capture: CaptureResult;
}

export class CaptureWindow {
  private window: BrowserWindow | null = null;
  private readonly preloadPath: string;

  constructor(preloadPath: string) {
    this.preloadPath = preloadPath;
  }

  openEditor({ capture }: OpenEditorOptions): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      this.send(capture);
      return;
    }

    const display = screen.getPrimaryDisplay();
    const { width: maxW, height: maxH } = display.workAreaSize;
    const scale = display.scaleFactor || 1;

    // Fit editor to the captured image's CSS-pixel size, plus chrome (toolbar
    // + status bar). Cap to ~90% of the display so the window is never larger
    // than the screen.
    const imgCssW = Math.round(capture.width / scale);
    const imgCssH = Math.round(capture.height / scale);
    const chromeH = 112;
    const winW = Math.min(Math.max(imgCssW + 80, 780), Math.round(maxW * 0.92));
    const winH = Math.min(Math.max(imgCssH + chromeH, 560), Math.round(maxH * 0.92));

    this.window = new BrowserWindow({
      width: winW,
      height: winH,
      minWidth: 640,
      minHeight: 420,
      show: false,
      frame: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
      backgroundColor: "#131316",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    this.window.on("closed", () => {
      this.window = null;
    });

    this.window.webContents.once("did-finish-load", () => {
      this.send(capture);
      this.window?.show();
      this.window?.focus();
    });

    void this.window.loadFile(path.join(rendererDir, "capture-editor.html"));
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
  }

  private send(capture: CaptureResult): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("marshal:capture-image-loaded", {
      base64: capture.base64,
      width: capture.width,
      height: capture.height,
      kind: capture.kind
    });
  }
}
