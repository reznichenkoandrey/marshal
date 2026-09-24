// desktop/capture/area-picker.ts
//
// Shared crop-overlay primitive for any feature that needs the user to draw
// a region on screen (capture studio, translator OCR, future modules).
//
// Why a dedicated module instead of reusing translator/screenshot-service.ts:
//   - ScreenshotService is coupled to the translator's "capture → crop → return
//     base64 of the cropped region" contract.
//   - Capture Studio needs the full display image + the region separately
//     (so it can run its own cropping, keep high-res scale, or capture
//     fullscreen without a picker at all).
//
// Contract:
//   pickArea(opts) → Promise<PickResult | null>   (null = user cancelled)
//
// The function captures the display under the pointer, opens the shared crop
// overlay (crop-overlay.ts) on that same display, and waits for the user to
// drag a region or press Esc. The overlay window itself lives there because
// the translator and live captions open the same one, and getting its geometry
// wrong offsets every selection (#223).
//
// Returned coordinates are in DIP (pre-scale) CSS pixels relative to that
// display — callers multiply by the returned `scaleFactor` when slicing the
// native PNG. Read it from the result, not from the primary display: scale
// factors differ between a Retina laptop screen and an external monitor.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { systemPreferences, type Display } from "electron";

import { openCropOverlay, type CropSelection } from "./crop-overlay.ts";
import { captureDisplay } from "./display-capture.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
// area-picker.ts compiles to dist/desktop/capture/, overlay lives in dist/desktop/renderer/
const rendererDir = path.join(desktopDistDir, "..", "renderer");

/** Selection rectangle in CSS pixels, relative to the captured display. */
export type AreaRegion = CropSelection;

export interface PickResult {
  /** Full-display PNG as base64 data URL (includes `data:image/png;base64,` prefix). */
  fullDataUrl: string;
  /** Region selected by the user, in CSS pixels relative to the captured display. */
  region: AreaRegion;
  /** Display scale factor — multiply region × scaleFactor for native-pixel cropping. */
  scaleFactor: number;
  /** Captured display bounds — useful when caller needs to map to global coords. */
  display: Display;
}

export interface PickAreaOptions {
  /** Absolute path to the Electron preload script. */
  preloadPath: string;
}

/**
 * Captures the display under the pointer and prompts the user to draw a crop
 * region. Returns null if the user pressed Esc or the selection was too small.
 *
 * Throws when Screen Recording permission is missing — callers should catch
 * and surface a user-facing prompt.
 */
export async function pickArea(opts: PickAreaOptions): Promise<PickResult | null> {
  if (process.platform === "darwin") {
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status !== "granted") {
      throw new Error(
        "Screen Recording permission required.\n" +
        "Open System Settings → Privacy & Security → Screen Recording\n" +
        "and enable Marshal, then restart the app."
      );
    }
  }

  // Capture the display the pointer is on, not whichever one macOS calls
  // primary — otherwise the overlay opens on the built-in screen while the
  // user is working on an external monitor (#136).
  const { image, display, scaleFactor } = await captureDisplay();

  const fullDataUrl = image.toDataURL();

  const region = await openCropOverlay({
    display,
    preloadPath: opts.preloadPath,
    rendererDir,
    screenshotDataUrl: fullDataUrl
  });
  if (!region) return null;

  return { fullDataUrl, region, scaleFactor, display };
}
