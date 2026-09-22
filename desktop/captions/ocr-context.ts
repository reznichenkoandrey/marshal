// desktop/captions/ocr-context.ts
//
// "Read the screen" for the captions overlay: grab a fixed region of the
// primary display, OCR it with the Vision helper, hand the text to the
// summarizer as context. The region is chosen once with the crop overlay
// and remembered; the hotkey after that is silent — no UI, just a snapshot.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { screen, systemPreferences } from "electron";

import { captureDisplay, screencaptureRectToFile } from "../capture/display-capture.ts";

import { runAppleVisionOcr } from "../translator/backends/apple-vision-backend.ts";
import type { OcrRegion } from "./captions-window.ts";

export function assertScreenRecordingGranted(): void {
  if (process.platform !== "darwin") return;
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    throw new Error(
      "Screen Recording permission required for live captions.\n" +
      "System Settings → Privacy & Security → Screen Recording → enable Marshal, then restart."
    );
  }
}

/**
 * Captures `region` (DIP coordinates on the primary display) to a PNG file.
 * Same capture path as the rest of the app (capture/display-capture.ts):
 * `screencapture` on macOS, desktopCapturer with a retry elsewhere (#182).
 */
export async function captureRegionToPng(region: OcrRegion): Promise<string> {
  assertScreenRecordingGranted();
  const file = path.join(tmpdir(), `marshal-captions-ocr-${randomUUID()}.png`);
  if (process.platform === "darwin") {
    await screencaptureRectToFile(region, file);
  } else {
    const { image, scaleFactor } = await captureDisplay(screen.getPrimaryDisplay());
    const cropped = image.crop({
      x: Math.round(region.x * scaleFactor),
      y: Math.round(region.y * scaleFactor),
      width: Math.round(region.width * scaleFactor),
      height: Math.round(region.height * scaleFactor)
    });
    await fs.writeFile(file, cropped.toPNG());
  }
  const stat = await fs.stat(file).catch(() => null);
  if (!stat || stat.size === 0) {
    await fs.unlink(file).catch(() => undefined);
    throw new Error("Screen capture produced an empty image.");
  }
  return file;
}

/** Full pipeline: capture → OCR → text. The temp file never outlives the call. */
export async function readRegionText(region: OcrRegion): Promise<string> {
  const file = await captureRegionToPng(region);
  try {
    return (await runAppleVisionOcr(file)).trim();
  } finally {
    await fs.unlink(file).catch(() => undefined);
  }
}
