// desktop/capture/capture-service.ts
//
// High-level entry points for the capture feature:
//   - captureArea()       → user draws a rectangle, get back a cropped PNG
//   - captureFullscreen() → snapshot of the display under the pointer
//
// The service only produces PNG bytes. Opening the annotation editor is the
// caller's responsibility (see desktop/main.ts wiring).

import { nativeImage, systemPreferences } from "electron";

import { pickArea } from "./area-picker.ts";
import { captureDisplay } from "./display-capture.ts";

export interface CaptureResult {
  /** PNG bytes as base64 WITHOUT the `data:image/png;base64,` prefix. */
  base64: string;
  /** Native-pixel dimensions of the returned PNG. */
  width: number;
  height: number;
  /** Kind of capture that produced this image — editor shows it in the title. */
  kind: "area" | "fullscreen";
}

export class CaptureService {
  private readonly preloadPath: string;

  constructor(preloadPath: string) {
    this.preloadPath = preloadPath;
  }

  async captureArea(): Promise<CaptureResult | null> {
    const pick = await pickArea({ preloadPath: this.preloadPath });
    if (!pick) return null;

    const image = nativeImage.createFromDataURL(pick.fullDataUrl);
    const scale = pick.scaleFactor;
    const cropped = image.crop({
      x: Math.round(pick.region.x * scale),
      y: Math.round(pick.region.y * scale),
      width: Math.round(pick.region.width * scale),
      height: Math.round(pick.region.height * scale)
    });

    const size = cropped.getSize();
    return {
      base64: cropped.toDataURL().replace(/^data:image\/\w+;base64,/u, ""),
      width: size.width,
      height: size.height,
      kind: "area"
    };
  }

  async captureFullscreen(): Promise<CaptureResult> {
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

    // The display under the pointer, not whichever one macOS calls primary:
    // on a multi-monitor setup the external screen was impossible to capture
    // because this always grabbed the built-in one (#136).
    const { image } = await captureDisplay();

    const size = image.getSize();
    return {
      base64: image.toDataURL().replace(/^data:image\/\w+;base64,/u, ""),
      width: size.width,
      height: size.height,
      kind: "fullscreen"
    };
  }
}
