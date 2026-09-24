// E2E check of the area-capture geometry in a real Electron runtime.
//
// #223: the crop overlay was created at the display origin, but Cocoa
// constrains an ordinary window to the visible frame and pushed it below the
// menu bar. The overlay's `clientY` was then short by the menu bar height, so
// the crop sliced a rectangle above the one the user drew — and a selection
// reaching the bottom of the screen asked for pixels past the end of the
// screenshot, which `nativeImage.crop()` clamped into a shorter image.
//
// Neither half of that is visible to a unit test: the numbers only go wrong
// once Cocoa has had its say about the window. So this drives the shipped
// `CaptureService.captureArea()` with real mouse input through the real
// overlay and checks the geometry that came back.
//
// The load-bearing check is the marker, not the pixel dimensions. A user can
// only point inside the visible screen, so the offset overlay still returned a
// PNG of the requested size — it just framed the wrong 39 points of screen.
// So the harness parks a solid magenta window at a known screen rect, selects
// a rectangle around it, and asserts the magenta starts where the selection
// says it should. Under the defect it starts a menu bar lower.
//
// Run: `npm run test:e2e:region`
//
// macOS only, and needs Screen Recording approved for the Electron bundle.
//
// Exit codes:
//   0 — every check passed
//   1 — a check failed (the report names which)
//   2 — the run threw before finishing

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, nativeImage, screen, systemPreferences } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const DIST = path.join(ROOT, "dist", "desktop");
const SHOTS = process.env.CLAUDE_SHOTS_DIR
  ? path.join(process.env.CLAUDE_SHOTS_DIR, "marshal")
  : path.join(os.homedir(), "Screenshots", "marshal");

const report = { steps: [], checks: {}, artifacts: [] };
const log = (step, detail) => {
  report.steps.push({ step, detail });
  console.log(`[live] ${step}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on("window-all-closed", () => {
  // This harness manages its own lifetime.
});

/**
 * Bounding box of the marker block inside a PNG, in native pixels, or null.
 * Scans the decoded bitmap (BGRA, row-major) rather than a screenshot of it.
 *
 * The left and top edges are taken independently, as minima over the whole
 * block: a frameless macOS window has rounded corners, so the first magenta
 * pixel in reading order sits a corner radius to the right of the real left
 * edge. Taking that pixel as the origin makes the check fail by ~22 points for
 * a reason that has nothing to do with the capture.
 */
function findMarker(pngBuffer) {
  const image = nativeImage.createFromBuffer(pngBuffer);
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  let minX = Infinity;
  let minY = Infinity;
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      // Loose thresholds: colour management shifts the exact values.
      if (bitmap[i] > 200 && bitmap[i + 1] < 70 && bitmap[i + 2] > 200) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        count += 1;
      }
    }
  }
  // A few stray pixels are not the marker; the block is tens of thousands.
  if (count < 1_000) return null;
  return { x: minX, y: minY, pixels: count };
}

/** The overlay is the only window matching the display it covers. */
async function waitForOverlay(display, exclude) {
  for (let i = 0; i < 100; i += 1) {
    await sleep(100);
    const found = BrowserWindow.getAllWindows().find((w) => {
      if (w.isDestroyed() || exclude.includes(w)) return false;
      const b = w.getBounds();
      return b.width === display.bounds.width && b.height === display.bounds.height;
    });
    if (found) return found;
  }
  return null;
}

/**
 * Drags between two SCREEN points, the way a hand does.
 *
 * `sendInputEvent` speaks the window's own client coordinates, so the screen
 * points are converted through the overlay's real bounds. Skipping that
 * conversion makes the harness shift its input by exactly the amount the
 * defect shifts the crop, the two cancel, and a broken build passes.
 */
async function dragThrough(win, screenFrom, screenTo, steps = 14) {
  const origin = win.getBounds();
  const from = { x: screenFrom.x - origin.x, y: screenFrom.y - origin.y };
  const to = { x: screenTo.x - origin.x, y: screenTo.y - origin.y };

  win.webContents.sendInputEvent({ type: "mouseDown", x: from.x, y: from.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) {
    win.webContents.sendInputEvent({
      type: "mouseMove",
      button: "left",
      x: Math.round(from.x + ((to.x - from.x) * i) / steps),
      y: Math.round(from.y + ((to.y - from.y) * i) / steps)
    });
    await sleep(10);
  }
  win.webContents.sendInputEvent({ type: "mouseUp", x: to.x, y: to.y, button: "left", clickCount: 1 });
}

app.whenReady().then(async () => {
  try {
    await fs.mkdir(SHOTS, { recursive: true });

    const permission = process.platform === "darwin"
      ? systemPreferences.getMediaAccessStatus("screen")
      : "granted";
    log("screen permission", permission);
    report.checks.screenPermission = permission;

    const { CaptureService } = await import(path.join(DIST, "capture", "capture-service.js"));
    const service = new CaptureService(path.join(DIST, "preload.cjs"));

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const scale = display.scaleFactor;

    // A solid block at a known screen rect. It doubles as the visible window
    // the compositor needs before it hands this process real frames — a
    // windowless one only gets a 0×0 thumbnail.
    const marker = {
      x: display.bounds.x + 300,
      y: display.bounds.y + 320,
      width: 360,
      height: 220
    };
    const holder = new BrowserWindow({
      ...marker,
      show: true,
      frame: false,
      hasShadow: false,
      backgroundColor: "#ff00ff"
    });
    await holder.loadURL("data:text/html,<body style='margin:0;background:#ff00ff'></body>");
    holder.setAlwaysOnTop(true, "floating");
    await sleep(700);
    const holderBounds = holder.getBounds();
    log("marker window", holderBounds);
    report.checks.markerWindow = holderBounds;
    log("display", { bounds: display.bounds, scale });
    report.checks.display = { bounds: display.bounds, scale };

    // ── 1. Overlay geometry ───────────────────────────────────────────────
    const pending = service.captureArea();
    const overlay = await waitForOverlay(display, [holder]);
    if (!overlay) throw new Error("crop overlay never opened");

    const overlayBounds = overlay.getBounds();
    log("overlay bounds", overlayBounds);
    report.checks.overlayBounds = overlayBounds;

    // The defect in one assertion: a shifted overlay means every selection
    // coordinate is off by the same amount.
    report.checks.overlayAtDisplayOrigin =
      overlayBounds.x === display.bounds.x && overlayBounds.y === display.bounds.y;

    const viewport = JSON.parse(
      await overlay.webContents.executeJavaScript(
        "JSON.stringify({ w: innerWidth, h: innerHeight, zoom: 1 })"
      )
    );
    log("overlay viewport", viewport);
    report.checks.overlayCoversDisplay =
      viewport.w === display.bounds.width && viewport.h === display.bounds.height;

    // ── 2. Draw a rectangle around the marker and check where it lands ──
    // Screen coordinates throughout — that is what the user points at, and
    // what the returned crop has to agree with.
    const from = { x: holderBounds.x - 100, y: holderBounds.y - 120 };
    const to = { x: holderBounds.x + holderBounds.width + 100, y: holderBounds.y + holderBounds.height + 120 };
    const expected = {
      width: (to.x - from.x) * scale,
      height: (to.y - from.y) * scale
    };
    log("dragging", { from, to, expected });

    await sleep(300);
    await dragThrough(overlay, from, to);

    const result = await pending;
    if (!result) throw new Error("captureArea returned null — the drag did not land");

    log("result size", { width: result.width, height: result.height });
    report.checks.expectedSize = expected;
    report.checks.resultSize = { width: result.width, height: result.height };
    // One native pixel of rounding slack; anything more is a real mismatch.
    report.checks.heightNotClipped = Math.abs(result.height - expected.height) <= 1;
    report.checks.widthMatches = Math.abs(result.width - expected.width) <= 1;

    const png = Buffer.from(result.base64, "base64");
    const out = path.join(SHOTS, "capture-region-e2e.png");
    await fs.writeFile(out, png);
    report.artifacts.push(out);

    // ── 3. The marker has to sit where the selection says it does ────────
    const found = findMarker(png);
    const want = {
      x: Math.round((holderBounds.x - from.x) * scale),
      y: Math.round((holderBounds.y - from.y) * scale)
    };
    log("marker in crop", { found, want });
    report.checks.markerFound = found !== null;
    report.checks.markerExpectedAt = want;
    report.checks.markerFoundAt = found;
    // 2 native px of slack for window shadows and rounding. The defect this
    // guards against moves the marker by a whole menu bar (78 px at 2×).
    report.checks.contentAlignedWithSelection =
      found !== null && Math.abs(found.x - want.x) <= 2 && Math.abs(found.y - want.y) <= 2;

    holder.destroy();

    // ── Verdict ───────────────────────────────────────────────────────────
    const mustPass = [
      "overlayAtDisplayOrigin",
      "overlayCoversDisplay",
      "heightNotClipped",
      "widthMatches",
      "markerFound",
      "contentAlignedWithSelection"
    ];
    report.failed = mustPass.filter((k) => report.checks[k] !== true);
    report.passed = report.failed.length === 0;

    await fs.writeFile(
      path.join(SHOTS, "capture-region-e2e-report.json"),
      JSON.stringify(report, null, 2)
    );
    console.log("\n===REPORT===\n" + JSON.stringify(report, null, 2) + "\n===END===");
    console.log(report.passed
      ? "\n[e2e] capture region: all checks passed"
      : `\n[e2e] capture region FAILED: ${report.failed.join(", ")}`);

    app.exit(report.passed ? 0 : 1);
  } catch (err) {
    console.error("[live] FAILED:", err);
    report.error = err instanceof Error ? err.stack : String(err);
    await fs.mkdir(SHOTS, { recursive: true }).catch(() => {});
    await fs.writeFile(
      path.join(SHOTS, "capture-region-e2e-report.json"),
      JSON.stringify(report, null, 2)
    ).catch(() => {});
    console.log("\n===REPORT===\n" + JSON.stringify(report, null, 2) + "\n===END===");
    app.exit(2);
  }
});
