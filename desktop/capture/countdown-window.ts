// desktop/capture/countdown-window.ts
//
// Transparent full-screen overlay that shows a 3-2-1 countdown before video
// recording starts. Resolves after the countdown finishes so the caller can
// kick off the actual recorder.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, screen } from "electron";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const rendererDir = path.join(desktopDistDir, "..", "renderer");

/** Show a 3-2-1 countdown on the primary display. Resolves once it's done. */
export function runCountdown(preloadPath: string, seconds = 3): Promise<void> {
  return new Promise((resolve) => {
    const display = screen.getPrimaryDisplay();
    const { x, y, width, height } = display.bounds;

    const win = new BrowserWindow({
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
      focusable: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Click-through — user should not be able to interact with the countdown.
    win.setIgnoreMouseEvents(true);

    const done = (): void => {
      if (!win.isDestroyed()) win.close();
      resolve();
    };

    win.webContents.once("did-finish-load", () => {
      win.webContents.send("marshal:countdown-start", { seconds });
    });

    // Safety net — always resolve, even if the renderer never reports back.
    const guard = setTimeout(done, (seconds + 1) * 1000 + 400);
    win.on("closed", () => clearTimeout(guard));

    void win.loadFile(path.join(rendererDir, "countdown.html"));
  });
}
