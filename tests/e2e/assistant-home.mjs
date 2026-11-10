// E2E check of the assistant home window (#284) in a real Electron renderer.
//
// Loads the shipped page with a stub `window.marshalAssistant`, drives every
// state the way main does, and reads back what a user would see: the chip,
// the state colour on the panel and in the canvas core, the hint or the
// assistant's own line, and which action each dock button sends. Also checks
// that the frame loop stops when the window is hidden and that
// prefers-reduced-motion leaves a still frame (#281).
//
// Microphone permission is denied on purpose: the spectrum then runs on its
// ambient level, which keeps the run deterministic and prompt-free.
//
// MARSHAL_E2E_SHOTS=<dir> also saves a screenshot per state, dark and light.
//
// Run: `npm run test:e2e:home`
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
const SHOTS = process.env.MARSHAL_E2E_SHOTS ?? "";

const STATES = ["idle", "listening", "thinking", "speaking", "working", "waiting", "offline"];
const UK_LABELS = {
  idle: "Готовий",
  listening: "Слухаю",
  thinking: "Думаю",
  speaking: "Говорю",
  working: "Працюю",
  waiting: "Чекає на тебе",
  offline: "Офлайн"
};
const STATE_TOKEN = {
  idle: "--state-idle",
  listening: "--state-listen",
  thinking: "--state-think",
  speaking: "--state-speak",
  working: "--state-think",
  waiting: "--state-wait",
  offline: "--state-fail"
};

const checks = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, passed, detail) {
  checks[name] = { passed, detail };
  console.log(`[home-e2e] ${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function preloadSource() {
  return `
const { contextBridge, ipcRenderer } = require("electron");
const actions = [];
let closed = 0;
contextBridge.exposeInMainWorld("marshalAssistant", {
  onState: (cb) => ipcRenderer.on("marshal:assistant-state", cb),
  action: async (name) => { actions.push(name); return { ok: true }; },
  close: async () => { closed += 1; return { ok: true }; }
});
contextBridge.exposeInMainWorld("__homeProbe", {
  actions: () => actions,
  closed: () => closed
});
`;
}

// What the page shows: chip, state attribute, the panel's state colour as the
// line's left border, and the line text.
const VIEW = `(() => {
  const home = document.getElementById("home");
  return {
    state: home.dataset.state,
    chip: document.getElementById("state-chip").textContent,
    line: document.getElementById("assistant-line").textContent,
    border: getComputedStyle(document.getElementById("assistant-line")).borderLeftColor
  };
})()`;

const TOKEN_RGB = (token) => `(() => {
  const probe = document.createElement("span");
  probe.style.color = "var(${token})";
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
})()`;

// Average colour of the core disc (inside the inner VU scale), skipping the
// readout text band across the middle. The core fades out towards its edge, so
// faint pixels count too: getImageData returns them unpremultiplied.
const CORE_RGB = `(() => {
  const canvas = document.getElementById("visual");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const w = canvas.width, c = w / 2, R = w * 0.26 * 0.55;
  const data = ctx.getImageData(0, 0, w, w).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.floor(c - R); y < c + R; y += 2) {
    if (y > c - w * 0.045 && y < c + w * 0.07) continue;
    for (let x = Math.floor(c - R); x < c + R; x += 2) {
      if (Math.hypot(x - c, y - c) > R) continue;
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a < 8) continue;
      r += data[i] * a; g += data[i + 1] * a; b += data[i + 2] * a; n += a;
    }
  }
  return n ? [r / n, g / n, b / n] : null;
})()`;

const CANVAS_STATS = `(() => {
  const canvas = document.getElementById("visual");
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let painted = 0, hash = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 30) painted += 1;
    hash = (hash * 31 + data[i - 3] + data[i - 2] * 7 + data[i - 1] * 13) | 0;
  }
  return { painted, total: data.length / 4, hash, width: canvas.width };
})()`;

const RAF_TICKS = `new Promise((resolve) => {
  let ticks = 0;
  const tick = () => { ticks += 1; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setTimeout(() => resolve(ticks), 1000);
})`;

function parseColor(value) {
  const text = String(value ?? "");
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(text);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const srgb = /color\(\s*srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)/.exec(text);
  if (srgb) return [srgb[1], srgb[2], srgb[3]].map((channel) => Number(channel) * 255);
  return null;
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

app.on("window-all-closed", () => {});

const WATCHDOG_MS = 90_000;
const watchdog = setTimeout(() => {
  console.error(`[home-e2e] timed out after ${WATCHDOG_MS}ms`);
  app.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

async function shoot(win, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  const image = await win.webContents.capturePage();
  await fs.writeFile(path.join(SHOTS, `${name}.png`), image.toPNG());
}

async function setAppearance(win, value) {
  await win.webContents.executeJavaScript(
    `localStorage.setItem("marshal-appearance", ${JSON.stringify(value)}); window.dispatchEvent(new Event("focus"));`
  );
  await sleep(300);
}

async function main() {
  await app.whenReady();

  const preloadPath = path.join(os.tmpdir(), `marshal-home-preload-${process.pid}.cjs`);
  await fs.writeFile(preloadPath, preloadSource(), "utf8");

  const win = new BrowserWindow({
    width: 640,
    height: 600,
    show: true,
    // Like the real window: an occluded one gets no animation frames.
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  const consoleErrors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });

  // The host's own Reduce motion (GitHub's macOS runner has it on) would leave
  // one still frame; pin motion explicitly and test reduced motion on purpose below.
  // The visual follows the media query's change event, so pinning after load is enough.
  await win.loadFile(path.join(RENDERER, "assistant-home.html"));
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
  });
  await setAppearance(win, "dark");
  await sleep(300);

  // ── The visual draws and moves ──────────────────────────────────────────
  const first = await win.webContents.executeJavaScript(CANVAS_STATS);
  record("the canvas is sized and painted", first.width > 200 && first.painted > first.total * 0.02,
    `${first.width}px, ${first.painted} of ${first.total} pixels`);
  const rafTicks = await win.webContents.executeJavaScript(RAF_TICKS);
  let second = first;
  for (let waited = 0; waited < 3000 && second.hash === first.hash; waited += 250) {
    await sleep(250);
    second = await win.webContents.executeJavaScript(CANVAS_STATS);
  }
  record("the visual animates while visible", second.hash !== first.hash, `${rafTicks} animation frames in 1 s`);

  // ── Every state ─────────────────────────────────────────────────────────
  const borders = {};
  for (const state of STATES) {
    win.webContents.send("marshal:assistant-state", { state, lang: "uk" });
    await sleep(1100);
    const view = await win.webContents.executeJavaScript(VIEW);
    borders[state] = view.border;
    record(`${state}: page follows the state`, view.state === state && view.chip === UK_LABELS[state],
      `${view.state} / ${view.chip}`);

    const token = parseColor(await win.webContents.executeJavaScript(TOKEN_RGB(STATE_TOKEN[state])));
    const border = parseColor(view.border);
    record(`${state}: panel takes the state colour`, token && border && distance(token, border) < 4,
      `${view.border} vs ${STATE_TOKEN[state]}`);

    const core = await win.webContents.executeJavaScript(CORE_RGB);
    const others = STATES.filter((other) => STATE_TOKEN[other] !== STATE_TOKEN[state]);
    let nearestOther = Infinity;
    for (const other of others) {
      const rgb = parseColor(await win.webContents.executeJavaScript(TOKEN_RGB(STATE_TOKEN[other])));
      if (rgb && core) nearestOther = Math.min(nearestOther, distance(core, rgb));
    }
    const own = core && token ? distance(core, token) : Infinity;
    record(`${state}: canvas core is drawn in the state colour`, own < nearestOther,
      core ? `own ${own.toFixed(0)} vs nearest other ${nearestOther.toFixed(0)}` : "no core pixels");
    await shoot(win, `home-dark-${state}`);
  }
  record("listening, thinking and waiting look different",
    new Set([borders.listening, borders.thinking, borders.waiting]).size === 3,
    `${borders.listening} | ${borders.thinking} | ${borders.waiting}`);

  // ── The assistant's own line replaces the hint ──────────────────────────
  win.webContents.send("marshal:assistant-state", { state: "idle", lang: "uk" });
  await sleep(100);
  const hint = (await win.webContents.executeJavaScript(VIEW)).line;
  record("idle shows a hint in Ukrainian", hint.includes("мікрофон"), hint);
  win.webContents.send("marshal:assistant-state", { state: "idle", lang: "uk", line: "Сесія marshal завершила: тести зелені" });
  await sleep(100);
  const said = (await win.webContents.executeJavaScript(VIEW)).line;
  record("a line from main replaces the hint", said === "Сесія marshal завершила: тести зелені", said);
  win.webContents.send("marshal:assistant-state", { state: "idle", lang: "en" });
  await sleep(100);
  const english = await win.webContents.executeJavaScript(VIEW);
  record("English follows the system language", english.chip === "Ready" && english.line.includes("mic"), english.chip);

  // ── Dock ────────────────────────────────────────────────────────────────
  const dock = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll(".dock [data-action]")].map((b) => ({ action: b.dataset.action, title: b.title, icon: !!b.querySelector("svg") }))`
  );
  record("every dock button has a title and an icon", dock.length === 8 && dock.every((b) => b.title && b.icon),
    dock.map((b) => b.action).join(", "));
  await win.webContents.executeJavaScript(`document.querySelectorAll(".dock [data-action]").forEach((b) => b.click())`);
  await sleep(100);
  const sent = await win.webContents.executeJavaScript(`window.__homeProbe.actions()`);
  record("dock clicks reach main by name", JSON.stringify(sent) === JSON.stringify(dock.map((b) => b.action)), sent.join(", "));
  await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  await sleep(50);
  record("Escape closes the window", (await win.webContents.executeJavaScript(`window.__homeProbe.closed()`)) === 1);

  // ── Light theme ─────────────────────────────────────────────────────────
  await setAppearance(win, "light");
  for (const state of ["idle", "listening", "waiting"]) {
    win.webContents.send("marshal:assistant-state", { state, lang: "uk" });
    await sleep(1000);
    await shoot(win, `home-light-${state}`);
  }
  win.webContents.send("marshal:assistant-state", { state: "listening", lang: "uk" });
  await sleep(1000);
  const lightToken = parseColor(await win.webContents.executeJavaScript(TOKEN_RGB("--state-listen")));
  const lightCore = await win.webContents.executeJavaScript(CORE_RGB);
  record("light theme redraws the canvas in light tokens", lightCore && lightToken && distance(lightCore, lightToken) < 120,
    lightCore ? `distance ${distance(lightCore, lightToken).toFixed(0)}` : "no core pixels");

  // ── Hidden window stops drawing (#281) ──────────────────────────────────
  win.hide();
  for (let waited = 0; waited < 3000; waited += 100) {
    if ((await win.webContents.executeJavaScript("document.visibilityState")) === "hidden") break;
    await sleep(100);
  }
  await sleep(100);
  const hiddenA = await win.webContents.executeJavaScript(CANVAS_STATS);
  await sleep(400);
  const hiddenB = await win.webContents.executeJavaScript(CANVAS_STATS);
  const visibility = await win.webContents.executeJavaScript("document.visibilityState");
  record("no frames are drawn while hidden", hiddenA.hash === hiddenB.hash, visibility);
  win.show();

  // ── Reduced motion leaves a still frame ─────────────────────────────────
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  await sleep(300);
  win.webContents.send("marshal:assistant-state", { state: "speaking", lang: "uk" });
  await sleep(300);
  const stillA = await win.webContents.executeJavaScript(CANVAS_STATS);
  await sleep(400);
  const stillB = await win.webContents.executeJavaScript(CANVAS_STATS);
  record("reduced motion: one still frame, still painted", stillA.hash === stillB.hash && stillA.painted > 0);
  win.webContents.debugger.detach();

  record("renderer logged no errors", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 300));

  await finish(win, preloadPath);
}

async function finish(win, preloadPath) {
  clearTimeout(watchdog);
  await fs.unlink(preloadPath).catch(() => {});
  win.destroy();

  const failed = Object.entries(checks).filter(([, value]) => !value.passed);
  console.log(`\n[home-e2e] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} checks passed`);
  if (failed.length > 0) {
    console.error(`[home-e2e] failed: ${failed.map(([name]) => name).join(", ")}`);
    app.exit(1);
    return;
  }
  app.exit(0);
}

main().catch((err) => {
  console.error("[home-e2e] threw:", err);
  app.exit(2);
});
