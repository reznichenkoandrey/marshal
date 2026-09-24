// E2E check of the live partial line on the captions overlay (#203).
//
// Loads the shipped overlay page with a stub `window.marshalCaptions` and
// pushes updates into it exactly as the main process does. What it checks is
// layout, which no unit test can see: a long partial must show its *end* —
// the newest words — and clip its beginning, the fade must appear only when
// something was actually clipped, and the brightest line must stay the latest
// final one rather than jumping to the provisional guess.
//
// No audio, no STT, no TCC grants — safe for the CI runner.
//
// Run: `npm run test:e2e:captions`
//
// Exit codes:
//   0 — every check passed
//   1 — a check failed (the report names which)
//   2 — the run threw before finishing

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RENDERER = path.join(ROOT, "dist", "desktop", "renderer");

// Mirrors OVERLAY_DEFAULT_WIDTH / HEIGHT in desktop/captions/overlay-layout.ts.
const OVERLAY_WIDTH = 640;
const OVERLAY_HEIGHT = 190;

const LONG_PARTIAL =
  "so the way we handle backpressure on the ingestion side is that every consumer group " +
  "gets its own bounded queue and when that queue fills up we stop acknowledging NEWEST_WORDS";

const checks = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, passed, detail) {
  checks[name] = { passed, detail };
  console.log(`[captions-e2e] ${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Stub preload: the overlay's IPC surface, with a hook to push updates. */
const PRELOAD = `
const { contextBridge } = require("electron");
let listener = null;
contextBridge.exposeInMainWorld("marshalCaptions", {
  stop: async () => {},
  onUpdate: (cb) => { listener = cb; return () => { listener = null; }; }
});
// Updates cross the isolated world through contextBridge, the same way the
// real ipcRenderer event does.
contextBridge.exposeInMainWorld("__captionsProbe", {
  push: (update) => { if (listener) listener({}, update); }
});
`;

function update(overrides) {
  return JSON.stringify({
    status: "listening",
    captions: [],
    partial: "",
    translations: [],
    summaryHtml: "",
    summaryStreaming: false,
    summaryStale: false,
    interactive: false,
    hint: "",
    ...overrides
  });
}

app.on("window-all-closed", () => {});

const WATCHDOG_MS = 60_000;
const watchdog = setTimeout(() => {
  console.error(`[captions-e2e] timed out after ${WATCHDOG_MS}ms`);
  app.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

async function main() {
  await app.whenReady();

  const preloadPath = path.join(os.tmpdir(), `marshal-captions-preload-${process.pid}.cjs`);
  await fs.writeFile(preloadPath, PRELOAD, "utf8");

  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  });
  const consoleErrors = [];
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  await win.loadFile(path.join(RENDERER, "captions-overlay.html"));
  await sleep(300);
  const js = (code) => win.webContents.executeJavaScript(code);

  // ── A long live line under two finished ones ──
  await js(`window.__captionsProbe.push(${update({
    captions: ["We shard the write path by tenant id.", "Reads go to the replicas."],
    partial: LONG_PARTIAL
  })})`);
  await sleep(150);

  const long = await js(`(() => {
    const line = document.querySelector("#captions .line.partial");
    if (!line) return null;
    const span = line.firstElementChild;
    const l = line.getBoundingClientRect();
    const s = span.getBoundingClientRect();
    const latest = document.querySelector("#captions .line.latest");
    return {
      text: span.textContent,
      endVisible: s.right <= l.right + 1,
      startClipped: s.left < l.left - 1,
      overflowing: line.classList.contains("overflowing"),
      italic: getComputedStyle(line).fontStyle,
      latestText: latest ? latest.textContent : null,
      latestColor: latest ? getComputedStyle(latest).color : null,
      partialColor: getComputedStyle(line).color
    };
  })()`);

  record("live line is rendered", long !== null && long.text === LONG_PARTIAL);
  record("newest words stay visible", long?.endVisible === true, "right edge of the text inside the line");
  record("the beginning is what gets clipped", long?.startClipped === true);
  record("fade marks the cut", long?.overflowing === true);
  record("live line reads as provisional", long?.italic === "italic");
  record(
    "the brightest line is still the latest final",
    long?.latestText === "Reads go to the replicas." && long?.latestColor !== long?.partialColor,
    `${long?.latestColor} vs ${long?.partialColor}`
  );

  // ── A short live line: no clipping, so no fade ──
  await js(`window.__captionsProbe.push(${update({ captions: ["Done."], partial: "and then we" })})`);
  await sleep(150);
  const short = await js(`(() => {
    const line = document.querySelector("#captions .line.partial");
    return line ? { overflowing: line.classList.contains("overflowing"), text: line.textContent } : null;
  })()`);
  record("a short live line is not faded", short?.overflowing === false, JSON.stringify(short));

  // ── Translated lines (#210): translation is the caption, original under the latest only ──
  await js(`window.__captionsProbe.push(${update({
    captions: ["We shard by tenant id.", "Reads go to the replicas."],
    translations: ["Ми шардимо по tenant id.", null]
  })})`);
  await sleep(150);
  const translated = await js(`(() => {
    const lines = [...document.querySelectorAll("#captions .line:not(.partial)")];
    return lines.map((line) => ({
      translated: line.classList.contains("translated"),
      text: line.querySelector(".translation")?.textContent ?? line.textContent,
      original: line.querySelector(".original")?.textContent ?? null,
      latest: line.classList.contains("latest")
    }));
  })()`);
  record(
    "a translated line shows the translation as the caption",
    translated[0]?.translated === true && translated[0]?.text === "Ми шардимо по tenant id."
  );
  record(
    "a line whose translation is pending shows the original",
    translated[1]?.translated === false && translated[1]?.text === "Reads go to the replicas."
  );
  await js(`window.__captionsProbe.push(${update({
    captions: ["We shard by tenant id.", "Reads go to the replicas."],
    translations: ["Ми шардимо по tenant id.", "Читання йдуть на репліки."]
  })})`);
  await sleep(150);
  const both = await js(`(() => {
    const lines = [...document.querySelectorAll("#captions .line:not(.partial)")];
    const body = document.getElementById("captions").getBoundingClientRect();
    return {
      originals: lines.map((line) => line.querySelector(".original")?.textContent ?? null),
      latestOriginalSmaller:
        parseFloat(getComputedStyle(lines[1].querySelector(".original")).fontSize) <
        parseFloat(getComputedStyle(lines[1].querySelector(".translation")).fontSize),
      latestVisible: lines[1].getBoundingClientRect().bottom <= body.bottom + 1
    };
  })()`);
  record(
    "only the latest line carries its original underneath",
    Array.isArray(both.originals) && both.originals[0] === null && both.originals[1] === "Reads go to the replicas.",
    JSON.stringify(both.originals)
  );
  record("the original is set smaller than the translation", both.latestOriginalSmaller === true);
  record("the latest translated line fits inside the captions area", both.latestVisible === true);

  // ── The final lands: the live line goes away ──
  await js(`window.__captionsProbe.push(${update({ captions: ["Done.", "And then we fan out."], partial: "" })})`);
  await sleep(150);
  const cleared = await js(`document.querySelectorAll("#captions .line.partial").length`);
  record("live line disappears when the final lands", cleared === 0);

  record("renderer logged no errors", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 300));

  await fs.unlink(preloadPath).catch(() => {});
  win.destroy();
  clearTimeout(watchdog);

  const failed = Object.entries(checks).filter(([, value]) => !value.passed);
  console.log(`\n[captions-e2e] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} checks passed`);
  app.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[captions-e2e] threw:", err);
  app.exit(2);
});
