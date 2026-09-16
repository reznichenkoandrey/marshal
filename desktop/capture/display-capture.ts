// desktop/capture/display-capture.ts
//
// Picking *which* screen to capture, shared by the area picker and the
// fullscreen service.
//
// Both used to hardcode `screen.getPrimaryDisplay()` and then take
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

import { desktopCapturer, screen, type Display, type NativeImage } from "electron";

import { pickSourceForDisplay } from "./display-source.ts";

export { pickSourceForDisplay } from "./display-source.ts";
export type { ScreenSourceLike } from "./display-source.ts";

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
 * Defaults to the display under the cursor. When the matching source cannot
 * be identified we fall back to the first source rather than failing outright
 * — a capture of the wrong screen is still recoverable by the user, an error
 * dialog mid-gesture is not — but we say so in the log.
 */
export async function captureDisplay(display: Display = activeDisplay()): Promise<DisplayCapture> {
  const { width, height } = display.bounds;
  const scaleFactor = display.scaleFactor;

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
  return { image: source.thumbnail, display, scaleFactor };
}
