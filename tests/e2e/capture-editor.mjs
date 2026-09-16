// E2E check of the capture editor in a real Electron runtime.
//
// Takes a genuine screen capture, opens the shipped annotation editor with it,
// and drives that editor with real mouse input (webContents.sendInputEvent)
// rather than by poking its internals — so every assertion travels the same
// path a user's pointer does. This is what caught #139, a layout defect that
// unit tests over the pure helpers cannot see.
//
// Run: `npm run test:e2e:capture`
//
// macOS only, and needs Screen Recording approved for the Electron bundle.
// Artifacts (the capture, the annotated editor, the post-crop state) are
// written outside the repo, per the screenshots-never-in-the-repo rule.
//
// Exit codes:
//   0 — every check passed
//   1 — a check failed (the report names which)
//   2 — the run threw before finishing

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, screen, desktopCapturer, systemPreferences } from "electron";

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

/** Real mouse drag through the window's input pipeline. */
async function drag(win, from, to, steps = 12) {
  win.webContents.sendInputEvent({ type: "mouseDown", x: from.x, y: from.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    win.webContents.sendInputEvent({ type: "mouseMove", x, y, button: "left" });
    await sleep(8);
  }
  win.webContents.sendInputEvent({ type: "mouseUp", x: to.x, y: to.y, button: "left", clickCount: 1 });
  await sleep(120);
}

async function click(win, at) {
  win.webContents.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await sleep(30);
  win.webContents.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await sleep(120);
}

async function typeText(win, text) {
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: "char", keyCode: ch });
    await sleep(15);
  }
  await sleep(80);
}

app.on("window-all-closed", () => {
  // Deliberately empty: this harness manages its own lifetime and must not
  // exit when the temporary capture-holder window closes.
});

app.whenReady().then(async () => {
  try {
    await fs.mkdir(SHOTS, { recursive: true });

    // ── 1. Real screen capture through the shipped service path ──────────
    const permission = process.platform === "darwin"
      ? systemPreferences.getMediaAccessStatus("screen")
      : "granted";
    log("screen permission", permission);
    report.checks.screenPermission = permission;

    // A visible window must exist before the compositor returns real frames;
    // capturing from a windowless process yields a 0x0 thumbnail.
    const holder = new BrowserWindow({ width: 360, height: 220, show: true, backgroundColor: "#202027" });
    await holder.loadURL("data:text/html,<body style='background:#202027'></body>");
    await sleep(800);

    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(display.bounds.width * display.scaleFactor),
        height: Math.round(display.bounds.height * display.scaleFactor)
      }
    });
    const shot = sources[0].thumbnail;
    const shotSize = shot.getSize();
    log("captured screen", shotSize);
    report.checks.captureSize = shotSize;
    report.checks.captureNonEmpty = shotSize.width > 100 && shotSize.height > 100;

    const rawPath = path.join(SHOTS, "live-1-captured-screen.png");
    await fs.writeFile(rawPath, shot.toPNG());
    report.artifacts.push(rawPath);

    // ── 2. Open the real editor with that capture ────────────────────────
    const win = new BrowserWindow({
      width: 1100,
      height: 760,
      show: true,
      frame: false,
      backgroundColor: "#131316",
      webPreferences: {
        preload: path.join(DIST, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    const consoleErrors = [];
    win.webContents.on("console-message", (_e, level, message) => {
      if (level >= 2) consoleErrors.push(message);
    });

    await win.loadFile(path.join(DIST, "renderer", "capture-editor.html"));
    holder.destroy();
    win.focus();
    win.webContents.focus();
    await sleep(500);

    win.webContents.send("marshal:capture-image-loaded", {
      base64: shot.toPNG().toString("base64"),
      width: shotSize.width,
      height: shotSize.height,
      kind: "fullscreen"
    });
    await sleep(900);
    log("editor loaded", "capture-editor.html");

    // ── 3. Toolbar shape: Select must be gone (#133) ─────────────────────
    const toolbar = await win.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('.tool[data-tool]')).map(b => b.dataset.tool)
    `);
    log("toolbar tools", toolbar);
    report.checks.toolbarTools = toolbar;
    report.checks.selectToolRemoved = !toolbar.includes("select");

    const activeAtStart = await win.webContents.executeJavaScript(`
      (document.querySelector('.tool.active') || {}).dataset?.tool ?? null
    `);
    report.checks.defaultTool = activeAtStart;

    // Geometry of the canvas in viewport coordinates, for real mouse input.
    const geom = await win.webContents.executeJavaScript(`
      (() => {
        const c = document.getElementById('draw-canvas').getBoundingClientRect();
        return { left: c.left, top: c.top, width: c.width, height: c.height };
      })()
    `);
    log("canvas rect", geom);
    report.checks.canvasOnScreen =
      geom.left >= 0 && geom.top >= 0 && geom.width > 50 && geom.height > 50;

    const pt = (fx, fy) => ({
      x: Math.round(geom.left + geom.width * fx),
      y: Math.round(geom.top + geom.height * fy)
    });

    const shapeCount = async () => win.webContents.executeJavaScript(`
      (() => {
        const c = document.getElementById('draw-canvas');
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let painted = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) painted++;
        return painted;
      })()
    `);

    const paintedEmpty = await shapeCount();
    report.checks.canvasEmptyBefore = paintedEmpty === 0;

    // ── 4. Draw a rectangle with real mouse input ────────────────────────
    await drag(win, pt(0.08, 0.12), pt(0.34, 0.36));
    const paintedRect = await shapeCount();
    log("after rectangle drag", { paintedPixels: paintedRect });
    report.checks.rectangleDrawn = paintedRect > 100;

    // ── 5. Arrow ─────────────────────────────────────────────────────────
    const arrowBtn = await win.webContents.executeJavaScript(`
      (() => { const b = document.querySelector('.tool[data-tool="arrow"]');
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()
    `);
    await click(win, arrowBtn);
    await drag(win, pt(0.45, 0.4), pt(0.72, 0.15));
    const paintedArrow = await shapeCount();
    log("after arrow drag", { paintedPixels: paintedArrow });
    report.checks.arrowDrawn = paintedArrow > paintedRect;

    // ── 6. Text tool — the #132 regression ───────────────────────────────
    // Driven through DOM events in a single synchronous block: a real mouse
    // click opens the textarea, but in an unfocused automation window it is
    // blurred (and committed empty) before we can fill it. The editor code
    // exercised here is identical either way.
    const textResult = await win.webContents.executeJavaScript(`
      (() => {
        const canvas = document.getElementById('draw-canvas');
        const input = document.getElementById('text-input');
        const rect = canvas.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width * 0.12);
        const y = Math.round(rect.top + rect.height * 0.60);

        document.querySelector('.tool[data-tool="text"]').click();

        canvas.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0
        }));

        const opened = !input.classList.contains('hidden');
        const fontSize = input.style.fontSize;

        input.value = 'Marshal';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        return { opened, fontSize, committed: input.classList.contains('hidden') };
      })()
    `);
    log("text tool", textResult);
    report.checks.textInputOpened = textResult.opened;
    report.checks.textInputFontSize = textResult.fontSize;

    await sleep(300);
    const paintedText = await shapeCount();
    report.checks.textDrawn = paintedText > paintedArrow;
    log("after text", { paintedPixels: paintedText, wasBeforeText: paintedArrow });

    // Measure the rasterized glyph height straight off the canvas: the #132
    // bug drew everything at the 10px default regardless of stroke width.
    const glyphHeight = await win.webContents.executeJavaScript(`
      (() => {
        const probe = document.createElement('canvas');
        const ctx = probe.getContext('2d');
        probe.width = 400; probe.height = 120;
        return import('./capture-shapes.js').then(mod => {
          const measure = (w) => {
            ctx.clearRect(0, 0, 400, 120);
            ctx.fillStyle = '#000';
            ctx.font = mod.textFontString(w);
            ctx.textBaseline = 'top';
            ctx.fillText('Mg', 10, 10);
            const d = ctx.getImageData(0, 0, 400, 120).data;
            let top = -1, bottom = -1;
            for (let row = 0; row < 120; row++) {
              for (let col = 0; col < 400; col++) {
                if (d[(row * 400 + col) * 4 + 3] > 8) {
                  if (top < 0) top = row;
                  bottom = row;
                  break;
                }
              }
            }
            return bottom - top + 1;
          };
          return { width2: measure(2), width4: measure(4), width8: measure(8) };
        });
      })()
    `);
    log("rasterized glyph height by stroke width", glyphHeight);

    // Direct proof that the shipped font string is accepted by this engine.
    const fontCheck = await win.webContents.executeJavaScript(`
      (async () => {
        const mod = await import('./capture-shapes.js');
        const probe = document.createElement('canvas').getContext('2d');
        probe.font = '10px sans-serif';
        const before = probe.font;
        probe.font = mod.textFontString(4);
        const after = probe.font;
        return { before, after, accepted: after !== before, stack: mod.CANVAS_FONT_STACK };
      })()
    `);
    log("font string in live renderer", fontCheck);
    report.checks.fontAccepted = fontCheck.accepted;
    report.checks.fontAfter = fontCheck.after;
    report.checks.fontHasNoCssVar = !fontCheck.stack.includes("var(");
    report.checks.glyphHeights = glyphHeight;
    // A 10px default font renders "Mg" about 7-8px tall. Real sizes must be
    // well clear of that and must grow with the picker.
    report.checks.glyphScalesWithWidth =
      glyphHeight.width2 > 9 &&
      glyphHeight.width4 > glyphHeight.width2 &&
      glyphHeight.width8 > glyphHeight.width4;

    const beforeCropPath = path.join(SHOTS, "live-2-editor-annotated.png");
    const beforeCropImg = await win.webContents.capturePage();
    await fs.writeFile(beforeCropPath, beforeCropImg.toPNG());
    report.artifacts.push(beforeCropPath);

    // ── 7. Crop, then confirm the tool is restored, not "select" (#133) ──
    const cropBtn = await win.webContents.executeJavaScript(`
      (() => { const b = document.querySelector('.tool[data-tool="crop"]');
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()
    `);
    await click(win, cropBtn);
    const toolDuringCrop = await win.webContents.executeJavaScript(`
      (document.querySelector('.tool.active') || {}).dataset?.tool ?? null
    `);
    report.checks.toolDuringCrop = toolDuringCrop;

    await drag(win, pt(0.05, 0.08), pt(0.8, 0.75));
    await sleep(900);

    const toolAfterCrop = await win.webContents.executeJavaScript(`
      (document.querySelector('.tool.active') || {}).dataset?.tool ?? null
    `);
    log("tool after crop", toolAfterCrop);
    report.checks.toolAfterCrop = toolAfterCrop;
    report.checks.cropRestoresUsableTool =
      toolAfterCrop !== null && toolAfterCrop !== "select" && toolAfterCrop !== "crop";

    // Drawing must work immediately after the crop — the old build looked
    // dead there. Use a drawable tool: the restored one may be "text", which
    // opens a textarea instead of painting.
    const rectBtn = await win.webContents.executeJavaScript(`
      (() => { const b = document.querySelector('.tool[data-tool="rect"]');
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()
    `);
    await click(win, rectBtn);
    const geomAfterCrop = await win.webContents.executeJavaScript(`
      (() => {
        const c = document.getElementById('draw-canvas').getBoundingClientRect();
        return { left: c.left, top: c.top, width: c.width, height: c.height };
      })()
    `);
    log("canvas rect after crop", geomAfterCrop);
    report.checks.canvasOnScreenAfterCrop =
      geomAfterCrop.left >= 0 && geomAfterCrop.top >= 0 && geomAfterCrop.width > 50;
    const pt2 = (fx, fy) => ({
      x: Math.round(geomAfterCrop.left + geomAfterCrop.width * fx),
      y: Math.round(geomAfterCrop.top + geomAfterCrop.height * fy)
    });

    const paintedAfterCrop = await shapeCount();
    await drag(win, pt2(0.15, 0.2), pt2(0.5, 0.5));
    const paintedAfterCropDraw = await shapeCount();
    log("draw right after crop", { before: paintedAfterCrop, after: paintedAfterCropDraw });
    report.checks.drawableRightAfterCrop = paintedAfterCropDraw > paintedAfterCrop;

    const afterCropPath = path.join(SHOTS, "live-3-after-crop.png");
    const afterCropImg = await win.webContents.capturePage();
    await fs.writeFile(afterCropPath, afterCropImg.toPNG());
    report.artifacts.push(afterCropPath);

    // The willReadFrequently line is a performance advisory Chromium emits
    // because this harness polls getImageData; it is not a product defect.
    const realErrors = consoleErrors.filter((m) => !m.includes("willReadFrequently"));
    report.checks.consoleErrors = realErrors;
    report.checks.noConsoleErrors = realErrors.length === 0;

    // ── Verdict ──────────────────────────────────────────────────────────
    const mustPass = [
      "captureNonEmpty",
      "canvasOnScreen",
      "canvasOnScreenAfterCrop",
      "selectToolRemoved",
      "rectangleDrawn",
      "arrowDrawn",
      "textInputOpened",
      "fontAccepted",
      "fontHasNoCssVar",
      "glyphScalesWithWidth",
      "textDrawn",
      "cropRestoresUsableTool",
      "drawableRightAfterCrop",
      "noConsoleErrors"
    ];
    report.failed = mustPass.filter((k) => report.checks[k] !== true);
    report.passed = report.failed.length === 0;

    await fs.writeFile(
      path.join(SHOTS, "capture-editor-e2e-report.json"),
      JSON.stringify(report, null, 2)
    );
    console.log("\n===REPORT===\n" + JSON.stringify(report, null, 2) + "\n===END===");
    console.log(report.passed
      ? "\n[e2e] capture editor: all checks passed"
      : `\n[e2e] capture editor FAILED: ${report.failed.join(", ")}`);

    win.destroy();
    app.exit(report.passed ? 0 : 1);
  } catch (err) {
    console.error("[live] FAILED:", err);
    report.error = err instanceof Error ? err.stack : String(err);
    await fs.writeFile(
      path.join(SHOTS, "capture-editor-e2e-report.json"),
      JSON.stringify(report, null, 2)
    ).catch(() => {});
    console.log("\n===REPORT===\n" + JSON.stringify(report, null, 2) + "\n===END===");
    app.exit(2);
  }
});
