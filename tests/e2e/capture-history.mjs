// E2E check of the capture history window in a real Electron renderer (#225).
//
// Loads the shipped history window with a stub `window.marshalHistory` and a
// fixed entry list, then types into the search field with real keyboard input
// (`webContents.sendInputEvent`) and reads back what the grid rendered.
//
// The stub is the point: the unit tests cover the matching and grouping rules
// as pure functions, but nothing there can catch a renderer that failed to
// load at all — and this window became an ES module in the same change, so a
// bad import path would leave a silently empty grid that every unit test still
// calls green. No filesystem, no IPC, no real captures.
//
// Run: `npm run test:e2e:history`
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

const checks = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, passed, detail) {
  checks[name] = { passed, detail };
  console.log(`[history-e2e] ${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
/** Local noon, N days back — never near a midnight the grouping could straddle. */
function noonDaysAgo(days) {
  const d = new Date(now - days * DAY_MS);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

const ENTRIES = [
  { name: "Marshal today area.png", kind: "image", bytes: 41_000, modifiedAt: noonDaysAgo(0), source: "archive" },
  { name: "Marshal today fullscreen.png", kind: "image", bytes: 90_000, modifiedAt: noonDaysAgo(0) - 3_600_000, source: "folder" },
  { name: "Marshal yesterday area.png", kind: "image", bytes: 33_000, modifiedAt: noonDaysAgo(1), source: "archive" },
  { name: "Marshal old recording.mov", kind: "video", bytes: 4_000_000, modifiedAt: noonDaysAgo(9), source: "folder" }
].map((entry) => ({ ...entry, path: `/fake/captures/${entry.name}` }));

/** A stub preload: the renderer's whole IPC surface, answered locally. */
function preloadSource() {
  return `
const { contextBridge, ipcRenderer } = require("electron");

const opened = [];

contextBridge.exposeInMainWorld("marshalHistory", {
  onLoaded: (cb) => ipcRenderer.on("marshal:capture-history-loaded", cb),
  refresh: async () => ({ ok: true }),
  revealFolder: async () => ({ ok: true }),
  reveal: async () => ({ ok: true }),
  close: async () => ({ ok: true }),
  openInEditor: async (p) => { opened.push(p); return { ok: true }; },
  openExternal: async (p) => { opened.push(p); return { ok: true }; }
});

// The stub lives in the isolated world, so the probe has to cross the bridge
// too — a plain assignment onto window here is invisible to the page.
contextBridge.exposeInMainWorld("__historyProbe", { opened: () => opened });
`;
}

/** Tile names currently in the grid, in render order. */
const TILE_NAMES = `[...document.querySelectorAll(".tile-name")].map((el) => el.textContent)`;
/** Day headings, without the "N captures" suffix each one carries. */
const DAY_LABELS = `[...document.querySelectorAll(".history-day-label")].map(
  (el) => el.firstChild.textContent.trim()
)`;

async function typeInto(win, selector, text) {
  await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: "char", keyCode: ch });
    await sleep(20);
  }
  await sleep(150);
}

async function clearSearch(win) {
  await win.webContents.executeJavaScript(
    `document.querySelector("#search").focus()`
  );
  // Esc is the renderer's own "clear the query" path, so exercise that rather
  // than setting .value and firing a synthetic event.
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await sleep(150);
}

app.on("window-all-closed", () => {});

// A module-level failure (a syntax error, a missing import) leaves Electron
// running with no windows and nothing to exit it, which reads as a hang rather
// than a failure. The watchdog turns that into an exit code.
const WATCHDOG_MS = 90_000;
const watchdog = setTimeout(() => {
  console.error(`[history-e2e] timed out after ${WATCHDOG_MS}ms`);
  app.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

async function main() {
  await app.whenReady();

  const preloadPath = path.join(os.tmpdir(), `marshal-history-preload-${process.pid}.cjs`);
  await fs.writeFile(preloadPath, preloadSource(), "utf8");

  const win = new BrowserWindow({
    width: 900,
    height: 640,
    show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  });

  const consoleErrors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  await win.loadFile(path.join(RENDERER, "capture-history.html"));
  win.webContents.send("marshal:capture-history-loaded", {
    folder: "/fake/captures",
    entries: ENTRIES
  });
  await sleep(400);

  // ── The grid rendered at all ────────────────────────────────────────────
  const names = await win.webContents.executeJavaScript(TILE_NAMES);
  record("every entry rendered a tile", names.length === ENTRIES.length, `${names.length} tiles`);

  const labels = await win.webContents.executeJavaScript(DAY_LABELS);
  record(
    "entries are grouped by day, newest first",
    labels[0] === "Today" && labels[1] === "Yesterday" && labels.length === 3,
    labels.join(" | ")
  );

  record(
    "today's group is ordered newest first",
    names[0] === "Marshal today area.png" && names[1] === "Marshal today fullscreen.png",
    names.slice(0, 2).join(" | ")
  );

  // An archived capture was never saved anywhere the user chose — the tile has
  // to say so, or "Reveal" landing in app support is a surprise.
  const notSaved = await win.webContents.executeJavaScript(
    `document.querySelectorAll(".tile-source").length`
  );
  record("archive-only entries are labelled", notSaved === 2, `${notSaved} labelled`);

  // ── Search ──────────────────────────────────────────────────────────────
  await typeInto(win, "#search", "yesterday");
  const afterDay = await win.webContents.executeJavaScript(TILE_NAMES);
  record(
    "searching a day heading narrows the grid",
    afterDay.length === 1 && afterDay[0] === "Marshal yesterday area.png",
    afterDay.join(" | ")
  );

  await clearSearch(win);
  const afterClear = await win.webContents.executeJavaScript(TILE_NAMES);
  record("Escape clears the query", afterClear.length === ENTRIES.length, `${afterClear.length} tiles`);

  await typeInto(win, "#search", "video");
  const afterKind = await win.webContents.executeJavaScript(TILE_NAMES);
  record(
    "searching a badge finds the recording",
    afterKind.length === 1 && afterKind[0] === "Marshal old recording.mov",
    afterKind.join(" | ")
  );

  await clearSearch(win);
  await typeInto(win, "#search", "nothing matches this");
  const emptyShown = await win.webContents.executeJavaScript(
    `!document.getElementById("empty").classList.contains("hidden")`
  );
  const emptyTiles = await win.webContents.executeJavaScript(TILE_NAMES);
  record("a query with no matches says so", emptyShown === true && emptyTiles.length === 0);

  // ── Re-editing ──────────────────────────────────────────────────────────
  await clearSearch(win);
  await win.webContents.executeJavaScript(`document.querySelector(".tile").click()`);
  await sleep(250);
  const opened = await win.webContents.executeJavaScript(`window.__historyProbe.opened()`);
  record(
    "clicking an image tile reopens it in the editor",
    opened.length === 1 && opened[0] === ENTRIES[0].path,
    opened.join(" | ")
  );

  record("renderer logged no errors", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 300));

  await finish(win, preloadPath);
}

async function finish(win, preloadPath) {
  clearTimeout(watchdog);
  await fs.unlink(preloadPath).catch(() => {});
  win.destroy();

  const failed = Object.entries(checks).filter(([, value]) => !value.passed);
  console.log(`\n[history-e2e] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} checks passed`);
  if (failed.length > 0) {
    console.error(`[history-e2e] failed: ${failed.map(([name]) => name).join(", ")}`);
    app.exit(1);
    return;
  }
  app.exit(0);
}

main().catch((err) => {
  console.error("[history-e2e] threw:", err);
  app.exit(2);
});
