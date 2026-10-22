// E2E check of the meeting recordings window in a real Electron renderer (#254).
//
// Loads the shipped window with a stub `window.marshalMeetingHistory` and a
// fixed entry list: a finished call, an interrupted one and one whose save
// failed with a long ffmpeg message. Clicks "Finish" and reads back what the
// rows show while main works and after it answers.
//
// The assembly itself is covered by tests/meeting-assembly.test.ts with the
// real ffmpeg; what only a renderer can show is which rows offer the action,
// that a second click is impossible while it runs, and that a long error no
// longer squeezes the buttons into one word per line.
//
// Run: `npm run test:e2e:meetings`
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
  console.log(`[meetings-e2e] ${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const LONG_ERROR =
  "ffmpeg meeting audio mix exited with code 1: " +
  "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x148717b00] moov atom not found ".repeat(12) +
  "/Users/someone/Library/Application Support/Marshal/meetings/meeting-20261020-172155-b6436a90/chunk-0002-system.m4a: Invalid data found when processing input";

const base = { mode: "audio", videoPath: null, warnings: [], error: null };
const ENTRIES = [
  {
    ...base,
    id: "meeting-done",
    state: "done",
    startedAt: "2026-10-21T12:00:00.000Z",
    durationMs: 861_000,
    folder: "/fake/meetings/meeting-done",
    audioPath: "/fake/meetings/meeting-done/meeting.m4a",
    bytes: 7_000_000
  },
  {
    ...base,
    id: "meeting-interrupted",
    state: "interrupted",
    startedAt: "2026-10-20T18:00:00.000Z",
    durationMs: null,
    folder: "/fake/meetings/meeting-interrupted",
    audioPath: null,
    bytes: 0
  },
  {
    ...base,
    id: "meeting-failed",
    state: "error",
    startedAt: "2026-10-20T14:21:55.000Z",
    durationMs: 595_000,
    folder: "/fake/meetings/meeting-failed",
    audioPath: null,
    bytes: 0,
    error: LONG_ERROR
  }
];

/** A stub preload: `finish` answers only when the test releases it. */
function preloadSource() {
  return `
const { contextBridge, ipcRenderer } = require("electron");

const finished = [];
let release = null;

contextBridge.exposeInMainWorld("marshalMeetingHistory", {
  onLoaded: (cb) => ipcRenderer.on("marshal:meeting-history-loaded", cb),
  refresh: async () => ({ ok: true }),
  reveal: async () => ({ ok: true }),
  revealFolder: async () => ({ ok: true }),
  trash: async () => ({ ok: true }),
  close: async () => ({ ok: true }),
  finish: (id) => {
    finished.push(id);
    return new Promise((resolve) => { release = () => resolve({ ok: true }); });
  }
});

contextBridge.exposeInMainWorld("__meetingProbe", {
  finished: () => finished,
  release: () => { if (release) release(); }
});
`;
}

/** Per row: its id (by date), subtitle, button labels and their state. */
const ROWS = `[...document.querySelectorAll(".meeting")].map((item) => {
  const sub = item.querySelector(".meeting-sub");
  return {
    date: item.querySelector(".meeting-date").textContent,
    sub: sub.textContent,
    subTitle: sub.title,
    subHeight: sub.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(sub).lineHeight) || 16,
    buttons: [...item.querySelectorAll(".meeting-actions button")].map((b) => ({
      label: b.textContent,
      disabled: b.disabled,
      height: b.getBoundingClientRect().height
    }))
  };
})`;
const TOOLBAR_BUTTON_HEIGHT = `document.getElementById("close-btn").getBoundingClientRect().height`;

function labels(row) {
  return row.buttons.map((b) => b.label).join(", ");
}

app.on("window-all-closed", () => {});

const WATCHDOG_MS = 90_000;
const watchdog = setTimeout(() => {
  console.error(`[meetings-e2e] timed out after ${WATCHDOG_MS}ms`);
  app.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

async function main() {
  await app.whenReady();

  const preloadPath = path.join(os.tmpdir(), `marshal-meetings-preload-${process.pid}.cjs`);
  await fs.writeFile(preloadPath, preloadSource(), "utf8");

  const win = new BrowserWindow({
    width: 820,
    height: 600,
    show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  });

  const consoleErrors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  await win.loadFile(path.join(RENDERER, "meeting-history.html"));
  win.webContents.send("marshal:meeting-history-loaded", { folder: "/fake/meetings", entries: ENTRIES });
  await sleep(400);

  // ── Which rows offer Finish ─────────────────────────────────────────────
  let rows = await win.webContents.executeJavaScript(ROWS);
  record("every entry rendered a row", rows.length === ENTRIES.length, `${rows.length} rows`);
  const [done, interrupted, failed] = rows;
  record("a finished recording offers no Finish", !done.buttons.some((b) => b.label === "Finish"), labels(done));
  record("an interrupted recording offers Finish", interrupted.buttons[0]?.label === "Finish", labels(interrupted));
  record("a failed recording offers Finish", failed.buttons[0]?.label === "Finish", labels(failed));

  // ── A long error no longer crushes the row ──────────────────────────────
  record(
    "a long error is cut to three lines",
    failed.subHeight <= failed.lineHeight * 3 + 2,
    `${Math.round(failed.subHeight)}px at ${failed.lineHeight}px per line`
  );
  record("the full error stays in the tooltip", failed.subTitle === `Failed: ${LONG_ERROR}`);
  const toolbarHeight = await win.webContents.executeJavaScript(TOOLBAR_BUTTON_HEIGHT);
  const tallest = Math.max(...failed.buttons.map((b) => b.height));
  record(
    "buttons beside a long error stay on one line",
    tallest <= toolbarHeight + 1,
    `${Math.round(tallest)}px vs ${Math.round(toolbarHeight)}px in the toolbar`
  );

  // ── Finishing ───────────────────────────────────────────────────────────
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll(".meeting")][2].querySelector(".meeting-actions button").click()`
  );
  await sleep(200);
  const calls = await win.webContents.executeJavaScript(`window.__meetingProbe.finished()`);
  record("Finish asks main for that recording", calls.length === 1 && calls[0] === "meeting-failed", calls.join(", "));

  rows = await win.webContents.executeJavaScript(ROWS);
  const busy = rows[2];
  record(
    "the button is disabled while main works",
    busy.buttons[0]?.label === "Finishing…" && busy.buttons[0]?.disabled === true,
    labels(busy)
  );
  record("Delete is gone while main works", !busy.buttons.some((b) => b.label === "Delete"), labels(busy));
  record("the row says what is happening", busy.sub === "Building the audio file…", busy.sub);

  // Main refreshes the list before answering, as MeetingHistoryWindow.finish does.
  win.webContents.send("marshal:meeting-history-loaded", {
    folder: "/fake/meetings",
    entries: ENTRIES.map((entry) =>
      entry.id === "meeting-failed"
        ? {
            ...entry,
            state: "done",
            error: null,
            audioPath: "/fake/meetings/meeting-failed/meeting.m4a",
            bytes: 4_000_000,
            warnings: ["Finished from raw chunks after the recording was interrupted."]
          }
        : entry
    )
  });
  await win.webContents.executeJavaScript(`window.__meetingProbe.release()`);
  await sleep(300);

  rows = await win.webContents.executeJavaScript(ROWS);
  const finished = rows[2];
  record("the finished row offers no Finish", !finished.buttons.some((b) => b.label === "Finish"), labels(finished));
  record("the finished row shows its length", finished.sub.startsWith("09:55"), finished.sub);

  record("renderer logged no errors", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 300));

  await finish(win, preloadPath);
}

async function finish(win, preloadPath) {
  clearTimeout(watchdog);
  await fs.unlink(preloadPath).catch(() => {});
  win.destroy();

  const failed = Object.entries(checks).filter(([, value]) => !value.passed);
  console.log(`\n[meetings-e2e] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} checks passed`);
  if (failed.length > 0) {
    console.error(`[meetings-e2e] failed: ${failed.map(([name]) => name).join(", ")}`);
    app.exit(1);
    return;
  }
  app.exit(0);
}

main().catch((err) => {
  console.error("[meetings-e2e] threw:", err);
  app.exit(2);
});
