// desktop/capture/display-capture.ts
//
// Picking *which* screen to capture, and actually capturing it. Shared by the
// area picker, the fullscreen service, the translator's crop flow and the
// live-captions OCR region.
//
// Both callers used to hardcode `screen.getPrimaryDisplay()` and then take
// `sources[0]` from desktopCapturer. On a multi-monitor setup that meant the
// crop overlay always opened on the built-in display no matter where the
// pointer was, and fullscreen always grabbed the primary screen — the external
// monitor could not be captured at all. See #136.
//
// Two separate mistakes hid in that pattern:
//   1. The wrong display was chosen (always primary, never the active one).
//   2. `sources[0]` is not guaranteed to be the display you asked about.
//      desktopCapturer returns one source per screen in an unspecified order,
//      so the source has to be matched by `display_id`.
//
// A third one surfaced in the packaged app on macOS 27: desktopCapturer hands
// back a 0×0 thumbnail roughly one call in three (#182). On macOS the pixels
// therefore come from `/usr/sbin/screencapture`, which runs under the app's
// own Screen Recording grant, honours content protection, and was reliable
// on every try; desktopCapturer stays as the path for other platforms, with a
// retry when it comes back empty.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { desktopCapturer, nativeImage, screen, type Display, type NativeImage, type Rectangle } from "electron";

import { pickSourceForDisplay } from "./display-source.ts";

export { pickSourceForDisplay } from "./display-source.ts";
export type { ScreenSourceLike } from "./display-source.ts";

const SCREENCAPTURE_BIN = "/usr/sbin/screencapture";
const SCREENCAPTURE_TIMEOUT_MS = 8_000;
/** desktopCapturer attempts before giving up on an empty thumbnail. */
const DESKTOP_CAPTURER_ATTEMPTS = 3;

/**
 * The display the user is currently working on — the one under the pointer.
 *
 * Cursor position is the honest signal here: the user is about to drag a
 * selection, and they drag it where their pointer already is.
 */
export function activeDisplay(): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

export interface DisplayCapture {
  /** Full-display screenshot at native resolution. */
  image: NativeImage;
  /** The display it came from. */
  display: Display;
  /** That display's scale factor — region maths needs it, and it is per-display. */
  scaleFactor: number;
}

/**
 * Captures one whole display at its native pixel resolution.
 *
 * Defaults to the display under the cursor.
 */
export async function captureDisplay(display: Display = activeDisplay()): Promise<DisplayCapture> {
  const image = process.platform === "darwin"
    ? await captureRectWithScreencapture(display.bounds)
    : await captureDisplayWithDesktopCapturer(display);
  return { image, display, scaleFactor: display.scaleFactor };
}

/**
 * Captures a rectangle given in screen points (DIP, global coordinates — any
 * display) to a PNG file via `screencapture`. The caller owns the file.
 * macOS only.
 */
export function screencaptureRectToFile(rect: Rectangle, file: string): Promise<void> {
  const region = [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n)).join(",");
  return new Promise((resolve, reject) => {
    // -x: no shutter sound, -R: rectangle in screen points, -t png.
    execFile(
      SCREENCAPTURE_BIN,
      ["-x", `-R${region}`, "-t", "png", file],
      { timeout: SCREENCAPTURE_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`screencapture failed: ${stderr.toString().trim() || err.message}`));
        else resolve();
      }
    );
  });
}

/** `screencaptureRectToFile` into memory; the temp file never outlives the call. */
export async function captureRectWithScreencapture(rect: Rectangle): Promise<NativeImage> {
  const file = path.join(tmpdir(), `marshal-capture-${randomUUID()}.png`);
  try {
    await screencaptureRectToFile(rect, file);
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) {
      throw new Error("screencapture produced an empty image — is Screen Recording granted to Marshal?");
    }
    return image;
  } finally {
    await fs.unlink(file).catch(() => undefined);
  }
}

/**
 * desktopCapturer path for non-macOS platforms. When the matching source
 * cannot be identified we fall back to the first source rather than failing
 * outright — a capture of the wrong screen is still recoverable by the user,
 * an error dialog mid-gesture is not — but we say so in the log. An empty
 * thumbnail is retried, because it is a transient failure, not a permission
 * problem.
 */
async function captureDisplayWithDesktopCapturer(display: Display): Promise<NativeImage> {
  const { width, height } = display.bounds;
  const scaleFactor = display.scaleFactor;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= DESKTOP_CAPTURER_ATTEMPTS; attempt += 1) {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(width * scaleFactor),
        height: Math.round(height * scaleFactor)
      }
    });
    if (sources.length === 0) throw new Error("No screen source available");

    const matched = pickSourceForDisplay(sources, display.id);
    if (!matched) {
      console.warn(
        `[marshal] capture: no source matched display ${display.id} ` +
        `(saw ${sources.map((s) => s.display_id).join(", ") || "none"}) — using the first source`
      );
    }
    const source = matched ?? sources[0];
    if (!source.thumbnail.isEmpty()) return source.thumbnail;

    lastError = new Error(`desktopCapturer returned an empty thumbnail (attempt ${attempt}/${DESKTOP_CAPTURER_ATTEMPTS})`);
    console.warn(`[marshal] capture: ${lastError.message}`);
  }
  throw lastError ?? new Error("desktopCapturer returned an empty thumbnail");
}
