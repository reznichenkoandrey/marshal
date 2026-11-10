// E2E check of the ambient indicators (#285) in a real Electron renderer.
//
// Mini widget: loads the shipped page with a stub `window.marshalAssistant`,
// checks the state colour, the "session needs you" cards and what a click,
// a double-click, a drag and a card click send to main. Then the idle pause:
// after 30 s in "idle" the canvas stops changing, and the next state change
// starts it again (#281).
// Glow frame: the edge light takes the listening colour, then the speaking one.
// Dictation indicator: drawn from tokens, in the listening colour.
//
// MARSHAL_E2E_SHOTS=<dir> also saves the widget, the frame and the indicator.
//
// Run: `npm run test:e2e:ambient`
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
const IDLE_PAUSE_MS = 30_000;
const SHOTS = process.env.MARSHAL_E2E_SHOTS ?? "";

async function shoot(win, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await fs.writeFile(path.join(SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}

const checks = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, passed, detail) {
  checks[name] = { passed, detail };
  console.log(`[ambient-e2e] ${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const PRELOAD = `
const { contextBridge, ipcRenderer } = require("electron");
const calls = [];
contextBridge.exposeInMainWorld("marshalAssistant", {
  onState: (cb) => ipcRenderer.on("marshal:assistant-state", cb),
  action: async (name) => { calls.push("action:" + name); return { ok: true }; },
  focusSession: async (pid) => { calls.push("focus:" + pid); return { ok: true }; },
  moveWidget: async (x, y, done) => { calls.push("move:" + (done ? "done" : "drag")); return { ok: true }; }
});
contextBridge.exposeInMainWorld("marshalDictation", { stop: async () => { calls.push("stop"); return { ok: true }; } });
contextBridge.exposeInMainWorld("__probe", { calls: () => calls.splice(0) });
`;

const TOKEN_RGB = (token) => `(() => {
  const probe = document.createElement("span");
  probe.style.color = "var(${token})";
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
})()`;

// The frame's edge line is the state token at 70%, as assistant-glow.html mixes it.
const EDGE_COLOR = (token) => `(() => {
  const probe = document.createElement("span");
  probe.style.color = "color-mix(in srgb, var(${token}) 70%, transparent)";
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
})()`;

const CANVAS_HASH = `(() => {
  const canvas = document.getElementById("visual");
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let painted = 0, hash = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 30) painted += 1;
    hash = (hash * 31 + data[i - 3] + data[i - 2] * 7 + data[i - 1] * 13) | 0;
  }
  return { painted, hash };
})()`;

function makeWindow(preloadPath, width, height) {
  return new BrowserWindow({
    width,
    height,
    show: true,
    frame: false,
    transparent: true,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false }
  });
}

// GitHub's macOS runner has Reduce motion on; the visual must animate here.
async function allowMotion(win) {
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
  });
}

async function mouse(win, type, x, y, clickCount = 1) {
  await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount });
}

async function checkWidget(preloadPath, errors) {
  const win = makeWindow(preloadPath, 168, 72 + 2 * 40);
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) errors.push(`widget: ${message}`);
  });
  await win.loadFile(path.join(RENDERER, "assistant-widget.html"));
  await allowMotion(win);
  const js = (code) => win.webContents.executeJavaScript(code);

  win.webContents.send("marshal:assistant-state", {
    state: "waiting",
    lang: "uk",
    cards: [
      { pid: 11, name: "marshal-ambient", waitingFor: "permission prompt" },
      { pid: 12, name: "snoriq", waitingFor: null }
    ]
  });
  await sleep(300);
  const view = await js(`(() => ({
    state: document.getElementById("widget").dataset.state,
    cards: [...document.querySelectorAll(".card")].map((card) => card.textContent),
    border: getComputedStyle(document.querySelector(".card")).borderLeftColor,
    label: document.getElementById("visual").getAttribute("aria-label")
  }))()`);
  const wait = await js(TOKEN_RGB("--state-wait"));
  record("cards list the waiting sessions", view.cards.join("|") === "marshal-ambientpermission prompt|snoriqчекає на тебе", view.cards.join("|"));
  record("cards carry the waiting colour", view.border === wait, `${view.border} vs ${wait}`);
  record("the visual is labelled in the UI language", view.label.startsWith("Чекає на тебе."), view.label);
  const painted = await js(CANVAS_HASH);
  record("the mini visual is drawn", painted.painted > 500, `${painted.painted} px`);
  await shoot(win, "widget-waiting");

  await js(`document.querySelectorAll(".card")[1].click()`);
  await sleep(50);
  const centre = 56;
  await mouse(win, "mousePressed", centre, centre);
  await mouse(win, "mouseReleased", centre, centre);
  await sleep(400);
  await mouse(win, "mousePressed", centre, centre, 1);
  await mouse(win, "mouseReleased", centre, centre, 1);
  await mouse(win, "mousePressed", centre, centre, 2);
  await mouse(win, "mouseReleased", centre, centre, 2);
  await sleep(400);
  await mouse(win, "mousePressed", centre, centre);
  await mouse(win, "mouseMoved", centre + 30, centre + 10);
  await mouse(win, "mouseMoved", centre + 60, centre + 20);
  await mouse(win, "mouseReleased", centre + 60, centre + 20);
  await sleep(200);
  const calls = await js(`window.__probe.calls()`);
  const drag = calls.filter((call) => call.startsWith("move:"));
  record("a card click focuses its session", calls[0] === "focus:12", calls.join(","));
  record("a click skips the phrase", calls[1] === "action:skip-speech", calls.join(","));
  record("a double-click opens the home only", calls[2] === "action:open-home" && calls.filter((call) => call === "action:skip-speech").length === 1, calls.join(","));
  record("a drag moves the widget and saves on release", drag.length >= 2 && drag.at(-1) === "move:done" && drag.slice(0, -1).every((call) => call === "move:drag"), drag.join(","));

  win.webContents.send("marshal:assistant-state", { state: "idle", lang: "uk", cards: [] });
  await sleep(500);
  const cardsAfter = await js(`document.querySelectorAll(".card").length`);
  record("cards go when no session waits", cardsAfter === 0);
  const runningA = await js(CANVAS_HASH);
  await sleep(500);
  const runningB = await js(CANVAS_HASH);
  record("idle still animates at first", runningA.hash !== runningB.hash);
  await sleep(IDLE_PAUSE_MS);
  const pausedA = await js(CANVAS_HASH);
  await sleep(600);
  const pausedB = await js(CANVAS_HASH);
  record("after 30 s of idle the visual stops", pausedA.hash === pausedB.hash && pausedA.painted > 0);
  win.webContents.send("marshal:assistant-state", { state: "speaking", lang: "uk", cards: [] });
  await sleep(400);
  const resumedA = await js(CANVAS_HASH);
  await sleep(400);
  const resumedB = await js(CANVAS_HASH);
  record("a state change starts it again", resumedA.hash !== resumedB.hash);

  win.webContents.debugger.detach();
  win.destroy();
}

async function checkGlow(preloadPath, errors) {
  const win = makeWindow(preloadPath, 400, 300);
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) errors.push(`glow: ${message}`);
  });
  await win.loadFile(path.join(RENDERER, "assistant-glow.html"));
  const read = () => win.webContents.executeJavaScript(`(() => {
    const frame = document.getElementById("frame");
    return { state: frame.dataset.state ?? null, shadow: getComputedStyle(frame).boxShadow };
  })()`);
  const before = await read();
  record("the frame is dark until main sends a state", before.state === null);
  win.webContents.send("marshal:assistant-state", { state: "listening" });
  await sleep(400);
  const listening = await read();
  await shoot(win, "glow-listening");
  const listen = await win.webContents.executeJavaScript(EDGE_COLOR("--state-listen"));
  win.webContents.send("marshal:assistant-state", { state: "speaking" });
  await sleep(400);
  const speaking = await read();
  const speak = await win.webContents.executeJavaScript(EDGE_COLOR("--state-speak"));
  record("listening glows in the listening colour", listening.state === "listening" && listening.shadow.startsWith(listen), `${listening.shadow} vs ${listen}`);
  record("speaking glows in the speaking colour", speaking.state === "speaking" && speaking.shadow.startsWith(speak), `${speaking.shadow} vs ${speak}`);
  win.destroy();
}

async function checkIndicator(preloadPath, errors) {
  const win = makeWindow(preloadPath, 210, 44);
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) errors.push(`indicator: ${message}`);
  });
  await win.loadFile(path.join(RENDERER, "dictation-indicator.html"));
  const view = await win.webContents.executeJavaScript(`(() => ({
    label: getComputedStyle(document.getElementById("label")).color,
    look: document.documentElement.dataset.look
  }))()`);
  const listen = await win.webContents.executeJavaScript(TOKEN_RGB("--state-listen"));
  await sleep(200);
  await shoot(win, "dictation-indicator");
  record("the indicator uses the listening token", view.label === listen && Boolean(view.look), `${view.label} vs ${listen}, look ${view.look}`);
  await win.webContents.executeJavaScript(`document.getElementById("stop").click()`);
  await sleep(50);
  const calls = await win.webContents.executeJavaScript(`window.__probe.calls()`);
  record("Stop still stops dictation", calls.join() === "stop", calls.join());
  win.destroy();
}

const watchdog = setTimeout(() => {
  console.error("[ambient-e2e] timed out");
  app.exit(2);
}, 120_000);

// Each check destroys its window before the next one opens: do not quit in between.
app.on("window-all-closed", () => {});

async function main() {
  await app.whenReady();
  const preloadPath = path.join(os.tmpdir(), `marshal-ambient-preload-${process.pid}.cjs`);
  await fs.writeFile(preloadPath, PRELOAD);
  const errors = [];
  try {
    await checkGlow(preloadPath, errors);
    await checkIndicator(preloadPath, errors);
    await checkWidget(preloadPath, errors);
  } finally {
    await fs.unlink(preloadPath).catch(() => {});
  }
  record("renderers logged no errors", errors.length === 0, errors.join(" | ").slice(0, 300));

  clearTimeout(watchdog);
  const failed = Object.entries(checks).filter(([, value]) => !value.passed);
  console.log(`\n[ambient-e2e] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} checks passed`);
  if (failed.length > 0) {
    console.error(`[ambient-e2e] failed: ${failed.map(([name]) => name).join(", ")}`);
    app.exit(1);
    return;
  }
  app.exit(0);
}

main().catch((err) => {
  console.error("[ambient-e2e] threw:", err);
  app.exit(2);
});
