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

import { desktopCapturer, screen, systemPreferences } from "electron";

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

/** Captures `region` (DIP coordinates on the primary display) to a PNG file. */
export async function captureRegionToPng(region: OcrRegion): Promise<string> {
  assertScreenRecordingGranted();
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;
  const scaleFactor = display.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) }
  });
  const primary = sources.find((source) => source.display_id === String(display.id)) ?? sources[0];
  if (!primary) throw new Error("No screen source available for OCR capture.");

  const cropped = primary.thumbnail.crop({
    x: Math.round(region.x * scaleFactor),
    y: Math.round(region.y * scaleFactor),
    width: Math.round(region.width * scaleFactor),
    height: Math.round(region.height * scaleFactor)
  });
  const file = path.join(tmpdir(), `marshal-captions-ocr-${randomUUID()}.png`);
  await fs.writeFile(file, cropped.toPNG());
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
