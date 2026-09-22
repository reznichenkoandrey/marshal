// desktop/captions/ocr-context.ts
//
// "Read the screen" for the captions overlay: grab a fixed region of the
// primary display, OCR it with the Vision helper, hand the text to the
// summarizer as context. The region is chosen once with the crop overlay
// and remembered; the hotkey after that is silent — no UI, just a snapshot.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { desktopCapturer, screen, systemPreferences } from "electron";

import { runAppleVisionOcr } from "../translator/backends/apple-vision-backend.ts";
import type { OcrRegion } from "./captions-window.ts";

const SCREENCAPTURE_BIN = "/usr/sbin/screencapture";
const SCREENCAPTURE_TIMEOUT_MS = 8_000;

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
 *
 * On macOS this shells out to `screencapture` rather than using
 * `desktopCapturer`: inside the packaged app the latter hands back a 0×0
 * thumbnail about one call in three (#182), and an empty PNG surfaces as a
 * confusing "failed to load image" from the OCR helper. `screencapture` runs
 * under the app's own Screen Recording grant, honours content protection,
 * and was reliable on every try.
 */
export async function captureRegionToPng(region: OcrRegion): Promise<string> {
  assertScreenRecordingGranted();
  const file = path.join(tmpdir(), `marshal-captions-ocr-${randomUUID()}.png`);
  if (process.platform === "darwin") {
    await captureWithScreencapture(region, file);
  } else {
    await captureWithDesktopCapturer(region, file);
  }
  const stat = await fs.stat(file).catch(() => null);
  if (!stat || stat.size === 0) {
    await fs.unlink(file).catch(() => undefined);
    throw new Error("Screen capture produced an empty image.");
  }
  return file;
}

function captureWithScreencapture(region: OcrRegion, file: string): Promise<void> {
  const rect = [region.x, region.y, region.width, region.height].map((n) => Math.round(n)).join(",");
  return new Promise((resolve, reject) => {
    // -x: no shutter sound, -R: rectangle in screen points, -t png.
    execFile(
      SCREENCAPTURE_BIN,
      ["-x", `-R${rect}`, "-t", "png", file],
      { timeout: SCREENCAPTURE_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`screencapture failed: ${stderr.toString().trim() || err.message}`));
        else resolve();
      }
    );
  });
}

async function captureWithDesktopCapturer(region: OcrRegion, file: string): Promise<void> {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;
  const scaleFactor = display.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) }
  });
  const primary = sources.find((source) => source.display_id === String(display.id)) ?? sources[0];
  if (!primary || primary.thumbnail.isEmpty()) throw new Error("No screen source available for OCR capture.");
  const cropped = primary.thumbnail.crop({
    x: Math.round(region.x * scaleFactor),
    y: Math.round(region.y * scaleFactor),
    width: Math.round(region.width * scaleFactor),
    height: Math.round(region.height * scaleFactor)
  });
  await fs.writeFile(file, cropped.toPNG());
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
