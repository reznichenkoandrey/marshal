/**
 * Generate tray icon PNGs for macOS menu bar from SVG source.
 *
 * Creates 18x18 @1x and 36x36 @2x icons with proper transparency.
 * Uses ImageMagick (convert) if available, falls back to raw pixel rendering.
 *
 * Icon: green (#0b5c56) rounded rectangle with white "M" letter.
 *
 * Run: node scripts/generate-tray-icon.mjs
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ASSETS_DIR = path.resolve(process.cwd(), "assets");
const SVG_PATH = path.join(ASSETS_DIR, "tray-icon.svg");

const SVG_CONTENT = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
  <rect width="36" height="36" rx="8" fill="#0b5c56"/>
  <path d="M9 27V9h3.6l5.4 9.2L23.4 9H27v18h-3V14.4l-4.6 7.8h-2.8L12 14.4V27z" fill="white"/>
</svg>`;

// Ensure SVG source exists
fs.writeFileSync(SVG_PATH, SVG_CONTENT);

/**
 * Try rendering SVG to PNG using ImageMagick's convert command.
 * Returns true on success.
 */
function tryImageMagick() {
  try {
    // Prefer magick (IMv7) over convert (IMv6, deprecated)
    try { execSync("which magick", { stdio: "ignore" }); } catch { execSync("which convert", { stdio: "ignore" }); }
  } catch {
    return false;
  }

  try {
    // Detect magick (IMv7) vs convert (IMv6)
    let cmd = "convert";
    try { execSync("which magick", { stdio: "ignore" }); cmd = "magick"; } catch { /* use convert */ }

    // 18x18 @1x
    execSync(
      `${cmd} -background none -density 144 -resize 18x18 "${SVG_PATH}" "PNG32:${path.join(ASSETS_DIR, "tray-icon.png")}"`,
      { stdio: "inherit" }
    );
    // 36x36 @2x
    execSync(
      `${cmd} -background none -density 288 -resize 36x36 "${SVG_PATH}" "PNG32:${path.join(ASSETS_DIR, "tray-icon@2x.png")}"`,
      { stdio: "inherit" }
    );

    const s1 = fs.statSync(path.join(ASSETS_DIR, "tray-icon.png")).size;
    const s2 = fs.statSync(path.join(ASSETS_DIR, "tray-icon@2x.png")).size;
    console.log(`Generated via ImageMagick: tray-icon.png (${s1} bytes), tray-icon@2x.png (${s2} bytes)`);
    return true;
  } catch (err) {
    console.warn("ImageMagick failed:", err.message);
    return false;
  }
}

/**
 * Fallback: render icon using raw pixel buffer + minimal PNG encoder.
 * No external deps. Quality is lower but functional.
 */
function fallbackRawPNG() {
  const icon1x = generateIcon(18);
  const icon2x = generateIcon(36);

  fs.writeFileSync(path.join(ASSETS_DIR, "tray-icon.png"), icon1x);
  fs.writeFileSync(path.join(ASSETS_DIR, "tray-icon@2x.png"), icon2x);

  console.log(`Generated via raw PNG: tray-icon.png (${icon1x.length} bytes), tray-icon@2x.png (${icon2x.length} bytes)`);
}

// --- Minimal PNG encoder ---

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const rawRows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawRows[y * (1 + width * 4)] = 0;
    rgba.copy(rawRows, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(rawRows, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crcBuf]);
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function setPixelAlpha(rgba, w, x, y, r, g, b, a) {
  if (x < 0 || x >= w || y < 0 || y >= w) return;
  const idx = (y * w + x) * 4;
  // Alpha blend
  const srcA = a / 255;
  const dstA = rgba[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA > 0) {
    rgba[idx] = Math.round((r * srcA + rgba[idx] * dstA * (1 - srcA)) / outA);
    rgba[idx + 1] = Math.round((g * srcA + rgba[idx + 1] * dstA * (1 - srcA)) / outA);
    rgba[idx + 2] = Math.round((b * srcA + rgba[idx + 2] * dstA * (1 - srcA)) / outA);
    rgba[idx + 3] = Math.round(outA * 255);
  }
}

function generateIcon(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const s = size / 36;
  const radius = 8 * s;

  // Draw rounded rect background
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const coverage = roundedRectCoverage(x, y, size, size, radius);
      if (coverage > 0) {
        const a = Math.round(coverage * 255);
        setPixelAlpha(rgba, size, x, y, 11, 92, 86, a);
      }
    }
  }

  // Draw M using anti-aliased line drawing
  const lw = Math.max(1.5, 3.2 * s); // line width

  // M path segments (from SVG: M9,27 V9 h3.6 l5.4,9.2 L23.4,9 H27 v18 h-3 V14.4 l-4.6,7.8 h-2.8 L12,14.4 V27 z)
  // Simplified as polygon fill
  const mPoly = [
    [9, 9], [12.6, 9], [18, 18.2], [23.4, 9], [27, 9],
    [27, 27], [24, 27], [24, 14.4], [19.4, 22.2], [16.6, 22.2],
    [12, 14.4], [12, 27], [9, 27],
  ].map(([px, py]) => [px * s, py * s]);

  // Scanline fill the M polygon
  for (let y = 0; y < size; y++) {
    const intersections = [];
    for (let i = 0; i < mPoly.length; i++) {
      const [x1, y1] = mPoly[i];
      const [x2, y2] = mPoly[(i + 1) % mPoly.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        const t = (y - y1) / (y2 - y1);
        intersections.push(x1 + t * (x2 - x1));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(0, Math.ceil(intersections[i]));
      const xEnd = Math.min(size - 1, Math.floor(intersections[i + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        setPixelAlpha(rgba, size, x, y, 255, 255, 255, 255);
      }
    }
  }

  return encodePNG(size, size, rgba);
}

/** Returns coverage (0-1) of pixel at (px, py) for a rounded rect */
function roundedRectCoverage(px, py, w, h, r) {
  // Simple: check distance from corners
  const cx = px + 0.5;
  const cy = py + 0.5;

  // Inside main body?
  if (cx >= r && cx <= w - r) return cy >= 0 && cy <= h ? 1 : 0;
  if (cy >= r && cy <= h - r) return cx >= 0 && cx <= w ? 1 : 0;

  // Corner regions
  let cornerCenterX, cornerCenterY;
  if (cx < r && cy < r) { cornerCenterX = r; cornerCenterY = r; }
  else if (cx > w - r && cy < r) { cornerCenterX = w - r; cornerCenterY = r; }
  else if (cx < r && cy > h - r) { cornerCenterX = r; cornerCenterY = h - r; }
  else if (cx > w - r && cy > h - r) { cornerCenterX = w - r; cornerCenterY = h - r; }
  else return 1;

  const dx = cx - cornerCenterX;
  const dy = cy - cornerCenterY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist <= r - 0.5) return 1;
  if (dist >= r + 0.5) return 0;
  return r + 0.5 - dist; // Anti-aliased edge
}

// --- Main ---
if (!tryImageMagick()) {
  fallbackRawPNG();
}
