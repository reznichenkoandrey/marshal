// E2E check of the assistant home window (#284) in a real Electron renderer.
//
// Loads the shipped page with a stub `window.marshalAssistant`, drives every
// state the way main does, and reads back what a user would see: the chip,
// the state colour on the panel and in the canvas core, the hint or the
// assistant's own line, and which action each dock button sends. Also checks
// that the frame loop stops when the window is hidden and that
// prefers-reduced-motion leaves a still frame (#281). The side panel (#308):
// sessions grouped by project and coloured by status, a click focuses the
// session by pid, and the last lines Marshal said.
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

const STATES = ["idle", "listening", "thinking", "speaking", "working", "waiting", "offline", "sleeping"];
const UK_LABELS = {
  idle: "Готовий",
  listening: "Слухаю",
  thinking: "Думаю",
  speaking: "Говорю",
  working: "Працюю",
  waiting: "Чекає на тебе",
  offline: "Офлайн",
  sleeping: "Сплю"
};
const STATE_TOKEN = {
  idle: "--state-idle",
  listening: "--state-listen",
  thinking: "--state-think",
  speaking: "--state-speak",
  working: "--state-think",
  waiting: "--state-wait",
  offline: "--state-fail",
  sleeping: "--state-idle"
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
const focused = [];
let closed = 0;
contextBridge.exposeInMainWorld("marshalAssistant", {
  onState: (cb) => ipcRenderer.on("marshal:assistant-state", cb),
  onShowSettings: (cb) => ipcRenderer.on("marshal:assistant-show-settings", () => cb()),
  action: async (name) => { actions.push(name); return { ok: true }; },
  close: async () => { closed += 1; return { ok: true }; },
  focusSession: async (pid) => {
    focused.push(pid);
    return pid === 999 ? { ok: false, error: "session is gone" } : { ok: true, focused: "tab" };
  }
});
// Settings (#317) read and save through marshalDesktop.
const saved = [];
const settings = { bridgeMode: "claude-cli", claudeModel: "", codexModel: "", dictationAutoPaste: false, calendarEnabled: false };
const none = async () => null;
contextBridge.exposeInMainWorld("marshalDesktop", {
  getSettings: async () => ({ ...settings }),
  updateSettings: async (next) => { saved.push(next); Object.assign(settings, next); return { ...settings }; },
  getSetupHealth: async () => ({ items: [] }),
  getClaudeCodeHooks: async () => ({ installed: false }),
  setClaudeCodeHooks: none,
  calendarStatus: async () => ({ configured: false }),
  calendarSetUrl: none,
  listMicrophones: async () => [],
  getSpeechVoices: async () => ({ voices: [] }),
  speakTestPhrase: none,
  selectDirectory: none,
  getDictationDefaults: async () => ({}),
  getCaptionsDefaults: async () => ({}),
  getCaptionsContextInfo: async () => ({ files: [] }),
  openCaptionsContextFolder: none,
  checkForUpdatesSilent: none,
  startUpdateInstall: none,
  onUpdateInstallProgress: () => () => {},
  openExternal: none
});
contextBridge.exposeInMainWorld("__homeProbe", {
  saved: () => saved,
  actions: () => actions,
  focused: () => focused,
  closed: () => closed
});
`;
}

// What the page shows: chip text and colour, state attribute, the hero's
// border (neutral in every state, #398) and the line text.
const VIEW = `(() => {
  const home = document.getElementById("home");
  return {
    state: home.dataset.state,
    chip: document.getElementById("state-chip").textContent,
    chipColor: getComputedStyle(document.getElementById("state-chip")).backgroundColor,
    hero: getComputedStyle(document.querySelector(".hero")).borderTopColor,
    line: document.getElementById("assistant-line").textContent
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

// The ribbon (#398): alpha painted in the left and right thirds of the canvas,
// and the average colour of the left third's dots (unpremultiplied).
const RIBBON = `(() => {
  const canvas = document.getElementById("visual");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  let left = 0, right = 0, r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a < 40) continue;
      if (x < w / 3) { left += a; r += data[i] * a; g += data[i + 1] * a; b += data[i + 2] * a; n += a; }
      else if (x > (w * 2) / 3) right += a;
    }
  }
  return { left, right, rgb: n ? [r / n, g / n, b / n] : null };
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

// The overview at the three widths the layout switches on.
async function shootWidths(win, prefix) {
  if (!SHOTS) return;
  for (const width of [520, 760, 1100]) {
    win.setSize(width, 720);
    await sleep(300);
    await shoot(win, `${prefix}-${width}`);
  }
  win.setSize(1100, 720);
  await sleep(250);
}

// The whole dashboard at 1100 px, for the side-by-side with the reference.
async function shootFull(win, name) {
  if (!SHOTS) return;
  win.setSize(1100, 1400);
  await sleep(400);
  await shoot(win, name);
  win.setSize(1100, 720);
  await sleep(250);
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
    width: 1100,
    height: 720,
    show: true,
    // Not like the real window (#336): an occluded test window gets no animation frames.
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
  const ribbon = await win.webContents.executeJavaScript(RIBBON);
  record("the wave is a ribbon on the left that fades right", ribbon.left > ribbon.right * 3,
    `left ${ribbon.left} vs right ${ribbon.right}`);
  const hairline = parseColor(await win.webContents.executeJavaScript(TOKEN_RGB("--border-hairline")));
  const chips = {};
  for (const state of STATES) {
    win.webContents.send("marshal:assistant-state", { state, lang: "uk" });
    await sleep(1100);
    const view = await win.webContents.executeJavaScript(VIEW);
    chips[state] = view.chipColor;
    record(`${state}: page follows the state`, view.state === state && view.chip === UK_LABELS[state],
      `${view.state} / ${view.chip}`);

    const token = parseColor(await win.webContents.executeJavaScript(TOKEN_RGB(STATE_TOKEN[state])));
    const chip = parseColor(view.chipColor);
    record(`${state}: the LIVE chip takes the state colour`, token && chip && distance(token, chip) < 4,
      `${view.chipColor} vs ${STATE_TOKEN[state]}`);
    const hero = parseColor(view.hero);
    record(`${state}: the hero stays neutral`, hairline && hero && distance(hairline, hero) < 4, view.hero);
    await shoot(win, `home-dark-${state}`);
  }
  record("listening, thinking and waiting look different",
    new Set([chips.listening, chips.thinking, chips.waiting]).size === 3,
    `${chips.listening} | ${chips.thinking} | ${chips.waiting}`);

  // ── The assistant's own line replaces the hint ──────────────────────────
  win.webContents.send("marshal:assistant-state", { state: "idle", lang: "uk" });
  await sleep(100);
  const hint = (await win.webContents.executeJavaScript(VIEW)).line;
  record("idle shows a hint in Ukrainian", hint.includes("мікрофон"), hint);
  const lines = ["Сесія marshal завершила: тести зелені", "Зустріч «Daily» за 5 хв", "Сесія api чекає на дозвіл"];
  win.webContents.send("marshal:assistant-state", { state: "idle", lang: "uk", lines });
  await sleep(100);
  const said = (await win.webContents.executeJavaScript(VIEW)).line;
  record("the newest line from main replaces the hint", said === lines[0], said);
  win.webContents.send("marshal:assistant-state", { state: "listening", lang: "uk" });
  await sleep(100);
  const guidance = (await win.webContents.executeJavaScript(VIEW)).line;
  record("listening shows its guidance over the last line", guidance !== lines[0] && guidance.length > 0, guidance);
  const recent = await win.webContents.executeJavaScript(`[...document.querySelectorAll("#recent li b")].map((b) => b.textContent)`);
  record("recent lists what Marshal said, newest first", JSON.stringify(recent) === JSON.stringify(lines), recent.join(" | "));

  // ── Sessions panel (#308) ───────────────────────────────────────────────
  const empty = await win.webContents.executeJavaScript(`document.getElementById("sessions-empty").textContent`);
  record("no sessions shows an empty note", empty === "Немає живих сесій", empty);
  win.webContents.send("marshal:assistant-state", {
    state: "waiting",
    lang: "uk",
    sessions: [
      { project: "marshal", sessions: [
        { pid: 101, name: "assistant-sessions", status: "waiting", waitingFor: "permission prompt" },
        { pid: 102, name: "release", status: "busy", waitingFor: null }
      ] },
      { project: "snoriq", sessions: [{ pid: 999, name: "docs", status: "idle", waitingFor: null }] }
    ]
  });
  await sleep(150);
  const panel = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll("#sessions > li")];
    return {
      rows: items.map((li) => li.classList.contains("project") ? "#" + li.textContent : li.querySelector(".session").dataset.status),
      title: document.querySelector('.session[data-pid="101"]').title,
      tag: document.querySelector('.session[data-pid="102"] .tag').textContent,
      empty: document.getElementById("sessions-empty").textContent,
      border: getComputedStyle(document.querySelector('.session[data-pid="101"]')).borderLeftColor
    };
  })()`);
  record("sessions are grouped by project in the order main sent",
    JSON.stringify(panel.rows) === JSON.stringify(["#marshal", "waiting", "busy", "#snoriq", "idle"]) && panel.empty === "",
    panel.rows.join(" "));
  record("hover names the session and what it waits for", panel.title === "assistant-sessions — permission prompt", panel.title);
  record("a busy session is tagged in Ukrainian", panel.tag === "працює", panel.tag);
  const waitToken = parseColor(await win.webContents.executeJavaScript(TOKEN_RGB("--state-wait")));
  const waitBorder = parseColor(panel.border);
  record("a waiting session takes the waiting colour", waitToken && waitBorder && distance(waitToken, waitBorder) < 4, panel.border);
  await shoot(win, "home-dark-sessions");
  await win.webContents.executeJavaScript(`document.querySelector('.session[data-pid="102"]').click()`);
  await sleep(100);
  record("a click focuses that session by pid", JSON.stringify(await win.webContents.executeJavaScript(`window.__homeProbe.focused()`)) === "[102]");
  await win.webContents.executeJavaScript(`document.querySelector('.session[data-pid="999"]').click()`);
  await sleep(100);
  const failedLine = (await win.webContents.executeJavaScript(VIEW)).line;
  record("a failed focus is said, not swallowed", failedLine.includes("session is gone"), failedLine);
  // ── Status strip (#309) ─────────────────────────────────────────────────
  const blank = await win.webContents.executeJavaScript(`({
    mem: document.getElementById("mem").hidden,
    meeting: document.getElementById("meeting").hidden,
    num: document.querySelector('.metric[data-metric="memory"] .num').textContent
  })`);
  record("no memory or meeting card until main sends a strip", blank.mem && blank.meeting && blank.num === "–", JSON.stringify(blank));
  const inTwelve = new Date(Date.now() + 12 * 60_000 - 5_000).toISOString();
  win.webContents.send("marshal:assistant-state", {
    state: "waiting",
    lang: "uk",
    strip: {
      active: { dictation: true, captions: false, translator: true, recording: false },
      speech: true,
      memory: { usedMb: 262, budgetMb: 300, split: [{ group: "main", mb: 88 }, { group: "gpu", mb: 52 }], measuredAt: new Date().toISOString() },
      meeting: { title: "Daily", start: inTwelve, joinable: true },
      hotkey: "CommandOrControl+Alt+A"
    }
  });
  await sleep(150);
  const stripView = await win.webContents.executeJavaScript(`(() => {
    const strip = document.getElementById("strip");
    return {
      visible: !strip.hidden && getComputedStyle(strip).display !== "none",
      lit: [...document.querySelectorAll(".dock button.on")].map((button) => button.dataset.action),
      litTitle: document.querySelector('.dock [data-action="translator"]').title,
      speech: strip.querySelector('[data-action="toggle-speech"]').getAttribute("aria-pressed"),
      lang: strip.querySelector('[data-action="toggle-language"]').textContent,
      mem: document.getElementById("mem-used").textContent + document.getElementById("mem-budget").textContent,
      metric: document.querySelector('.metric[data-metric="memory"] .num').textContent,
      split: [...document.querySelectorAll("#mem-split li")].map((li) => li.dataset.group).join(),
      cells: document.querySelectorAll("#batt i.on").length,
      meeting: document.getElementById("meeting-title").textContent + " " + document.getElementById("meeting-when").textContent,
      join: !document.getElementById("join").hidden,
      hotkey: document.getElementById("hotkey").textContent
    };
  })()`);
  record("the dock lights what runs (#341)",
    stripView.visible && stripView.lit.join() === "translator" && stripView.litTitle.endsWith("· увімкнено"),
    `${stripView.lit.join()} — ${stripView.litTitle}`);
  record("toggles show their state", stripView.speech === "true" && stripView.lang === "UK", `${stripView.speech} / ${stripView.lang}`);
  record("memory reads against the idle budget, split by process",
    stripView.mem === "262/ 300 MB" && stripView.metric === "262" && stripView.cells === 9 && stripView.split === "main,gpu",
    `${stripView.mem}, ${stripView.cells} cells, ${stripView.split}`);
  record("the next meeting counts down with Join", stripView.meeting === "Daily за 12 хв" && stripView.join, stripView.meeting);
  record("the hotkey is shown as keys", stripView.hotkey === "⌘⌥A", stripView.hotkey);
  await shoot(win, "home-dark-strip");
  const before = (await win.webContents.executeJavaScript(`window.__homeProbe.actions()`)).length;
  await win.webContents.executeJavaScript(
    `["toggle-speech", "toggle-language", "join-meeting"].forEach((name) => document.querySelector('[data-action="' + name + '"]').click())`
  );
  await sleep(100);
  const stripSent = (await win.webContents.executeJavaScript(`window.__homeProbe.actions()`)).slice(before);
  record("strip clicks reach main by name", stripSent.join() === "toggle-speech,toggle-language,join-meeting", stripSent.join());
  win.webContents.send("marshal:assistant-state", {
    state: "waiting",
    lang: "uk",
    strip: {
      active: { dictation: false, captions: false, translator: false, recording: true },
      speech: false,
      memory: { usedMb: 340, budgetMb: 300 },
      meeting: { title: "Retro", start: new Date(Date.now() - 60_000).toISOString(), joinable: false },
      hotkey: null
    }
  });
  await sleep(150);
  const over = await win.webContents.executeJavaScript(`({
    over: document.getElementById("mem").classList.contains("over"),
    when: document.getElementById("meeting-when").textContent,
    join: document.getElementById("join").hidden,
    hotkey: document.getElementById("hotkey").hidden
  })`);
  record("over budget, a started meeting without a link and no hotkey read as such",
    over.over && over.when === "триває" && over.join && over.hotkey, JSON.stringify(over));

  // ── Features and recent commands (#398) ────────────────────────────────
  const now = Date.now();
  const dashboard = (state) => ({
    state,
    lang: "uk",
    sessions: [
      { project: "marshal", sessions: [{ pid: 101, name: "assistant-sessions", status: "waiting", waitingFor: "permission prompt" }] },
      { project: "snoriq", sessions: [{ pid: 999, name: "docs", status: "busy", waitingFor: null }] }
    ],
    lines: ["Сесія marshal завершила: тести зелені", "Зустріч «Daily» за 12 хв"],
    features: [
      { id: "dictation", state: "ready", stats: ["large-v3-turbo-q8_0", "resident"] },
      { id: "captions", state: "running", stats: ["whisper.cpp"] },
      { id: "translator", state: "error", stats: ["claude-cli", "1.2s"] },
      { id: "speech", state: "off", stats: ["say"] },
      { id: "calendar", state: "no_model", stats: ["–"] }
    ],
    commands: {
      rows: [
        { text: "перекладач", at: now - 60_000, target: "translator", kind: "feature", outcome: "answered", durationMs: 840 },
        { text: "що там по сесіях", at: now - 5 * 60_000, target: "marshal", kind: "general", outcome: "answered", durationMs: 4200 },
        { text: "запусти тести в marshal", at: now - 9 * 60_000, target: "marshal", kind: "session", outcome: "sent", durationMs: null },
        { text: "відкрий snoriq", at: now - 30 * 60_000, target: "snoriq", kind: "session", outcome: "failed", durationMs: 1500 },
        { text: "архівуй", at: now - 50 * 60_000, target: null, kind: null, outcome: "no_answer", durationMs: null }
      ],
      day: { current: 5, previous: 3 },
      week: { current: 21, previous: 30 }
    },
    strip: {
      active: { dictation: false, captions: true, translator: false, recording: false },
      speech: true,
      memory: { usedMb: 214, budgetMb: 300, split: [
        { group: "main", mb: 88 }, { group: "renderer", mb: 55 }, { group: "gpu", mb: 41 }, { group: "service", mb: 22 }, { group: "helpers", mb: 8 }
      ], measuredAt: new Date().toISOString() },
      meeting: { title: "Daily", start: inTwelve, joinable: true },
      hotkey: "CommandOrControl+Alt+A"
    }
  });
  win.webContents.send("marshal:assistant-state", dashboard("idle"));
  await sleep(200);
  const dash = await win.webContents.executeJavaScript(`(() => ({
    features: [...document.querySelectorAll("#features .feature")].map((card) => card.dataset.feature + ":" + card.dataset.state),
    errorBorder: getComputedStyle(document.querySelector('.feature[data-state="error"]')).borderTopColor,
    readyBorder: getComputedStyle(document.querySelector('.feature[data-state="ready"]')).borderTopColor,
    note: document.getElementById("features-note").textContent,
    outcomes: [...document.querySelectorAll("#commands tr")].map((tr) => tr.dataset.outcome),
    chip: document.querySelector("#commands tr .ochip").textContent,
    took: document.querySelector("#commands tr td:last-child").textContent,
    commands: document.querySelector('.metric[data-metric="commands"]').textContent,
    alerts: [...document.querySelectorAll("#recent li")].map((li) => li.dataset.level)
  }))()`);
  record("every feature gets a card with its state",
    dash.features.join() === "dictation:ready,captions:running,translator:error,speech:off,calendar:no_model" && dash.note.length > 0,
    `${dash.features.join()} — ${dash.note}`);
  record("an erroring feature card has a red border", dash.errorBorder !== dash.readyBorder, `${dash.errorBorder} vs ${dash.readyBorder}`);
  record("recent commands show the outcome, newest first",
    dash.outcomes.join() === "answered,answered,sent,failed,no_answer" && dash.chip.length > 0 && dash.took === "0.8s",
    `${dash.outcomes.join()} — ${dash.chip}, ${dash.took}`);
  record("the commands metric compares with yesterday", dash.commands.includes("5") && dash.commands.includes("+2"), dash.commands);
  await win.webContents.executeJavaScript(`document.querySelector('#range [data-range="7"]').click()`);
  await sleep(50);
  const week = await win.webContents.executeJavaScript(`document.querySelector('.metric[data-metric="commands"]').textContent`);
  record("7D switches the commands metric to the week", week.includes("21") && week.includes("-9"), week);
  await win.webContents.executeJavaScript(`document.querySelector('#range [data-range="1"]').click()`);
  record("a permission wait is a critical alert", dash.alerts[0] === "critical" && dash.alerts.includes("info"), dash.alerts.join());

  await shootWidths(win, "home-dark-overview");
  await shootFull(win, "home-dark-full");
  win.setSize(640, 600);
  await sleep(300);
  const narrow = await win.webContents.executeJavaScript(`(() => {
    const side = document.querySelector(".side").getBoundingClientRect();
    const dash = document.querySelector(".dash > .block:last-of-type").getBoundingClientRect();
    return { side: side.top >= dash.bottom - 1 && side.width > 0, visual: document.getElementById("visual").getBoundingClientRect().width > 0 };
  })()`);
  record("a narrow window moves the rail under the main column", narrow.side && narrow.visual, JSON.stringify(narrow));
  win.setSize(1100, 720);
  await sleep(300);
  const RAIL = `document.querySelector("#settings-rail [data-section='dictation']").textContent`;
  const ukRail = await win.webContents.executeJavaScript(RAIL);
  win.webContents.send("marshal:assistant-state", { state: "idle", lang: "en", lines: [], sessions: [] });
  await sleep(100);
  const enRail = await win.webContents.executeJavaScript(RAIL);
  record("the Settings markup follows the UI language (#330)", ukRail === "Диктовка" && enRail === "Dictation", `${ukRail} / ${enRail}`);
  const english = await win.webContents.executeJavaScript(VIEW);
  const sideTitle = await win.webContents.executeJavaScript(`document.getElementById("sessions-title").textContent`);
  record("English follows the system language",
    english.chip === "Ready" && english.line.includes("mic") && sideTitle === "Claude Code sessions", `${english.chip} / ${sideTitle}`);

  // ── Dock ────────────────────────────────────────────────────────────────
  const dock = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll(".dock [data-action]")].map((b) => ({ action: b.dataset.action, title: b.title, icon: !!b.querySelector("svg") }))`
  );
  record("every dock button has a title and an icon", dock.length === 7 && dock.every((b) => b.title && b.icon),
    dock.map((b) => b.action).join(", "));
  record("the dock has no agent chat (#317)", !dock.some((b) => b.action === "agent"));
  const earlier = (await win.webContents.executeJavaScript(`window.__homeProbe.actions()`)).length;
  await win.webContents.executeJavaScript(`document.querySelectorAll(".dock [data-action]:not([data-action='settings'])").forEach((b) => b.click())`);
  await sleep(100);
  const sent = (await win.webContents.executeJavaScript(`window.__homeProbe.actions()`)).slice(earlier);
  const toMain = dock.map((b) => b.action).filter((action) => action !== "settings");
  record("dock clicks reach main by name", JSON.stringify(sent) === JSON.stringify(toMain), sent.join(", "));

  // ── Settings view (#317) ────────────────────────────────────────────────
  await win.webContents.executeJavaScript(`document.querySelector(".dock [data-action='settings']").click()`);
  await sleep(300);
  const opened = await win.webContents.executeJavaScript(`(() => ({
    view: document.getElementById("home").dataset.view,
    shown: !document.getElementById("settings").hidden,
    side: getComputedStyle(document.querySelector(".side")).display,
    dash: getComputedStyle(document.querySelector(".dash")).display,
    sections: document.querySelectorAll("#settings-form .settings-section").length,
    rail: document.querySelectorAll("#settings-rail .rail-btn").length,
    bridge: document.getElementById("settings-bridge-mode").value
  }))()`);
  record("Settings in the dock opens settings inside the home, not another window",
    opened.view === "settings" && opened.shown && opened.side === "none" && opened.dash === "none",
    JSON.stringify(opened));
  record("every section has a rail entry and the form is filled from main",
    opened.sections === 9 && opened.rail === 9 && opened.bridge === "claude-cli", `${opened.sections}/${opened.rail}, ${opened.bridge}`);
  record("the settings button stays out of main", (await win.webContents.executeJavaScript(`window.__homeProbe.actions()`)).every((a) => a !== "settings"));

  await win.webContents.executeJavaScript(`document.querySelector("#settings-rail [data-section='dictation']").click()`);
  await sleep(300);
  const jumped = await win.webContents.executeJavaScript(`(() => {
    const scroll = document.getElementById("settings-form");
    const section = document.getElementById("settings-sec-dictation");
    return {
      offset: Math.round(section.getBoundingClientRect().top - scroll.getBoundingClientRect().top),
      current: document.querySelector("#settings-rail [aria-current='true']")?.dataset.section
    };
  })()`);
  record("the rail scrolls to its section and marks it", Math.abs(jumped.offset) < 40 && jumped.current === "dictation", JSON.stringify(jumped));

  await win.webContents.executeJavaScript(`document.getElementById("settings-dictation-autopaste").click()`);
  await win.webContents.executeJavaScript(`document.getElementById("settings-save").click()`);
  await sleep(300);
  const savedPayloads = await win.webContents.executeJavaScript(`window.__homeProbe.saved()`);
  record("Save sends the changed toggle to main",
    savedPayloads.length === 1 && savedPayloads[0].dictationAutoPaste === true && savedPayloads[0].bridgeMode === "claude-cli",
    JSON.stringify(savedPayloads[0] ?? null).slice(0, 160));
  const status = await win.webContents.executeJavaScript(`document.getElementById("settings-status").textContent`);
  record("Save says it saved", status.length > 0, status);
  await sleep(1000);
  record("a successful save returns to the home view",
    await win.webContents.executeJavaScript(`document.getElementById("home").dataset.view === undefined && document.getElementById("settings").hidden`));

  win.webContents.send("marshal:assistant-show-settings");
  await sleep(200);
  record("main can open the settings view",
    await win.webContents.executeJavaScript(`document.getElementById("home").dataset.view === "settings"`));
  if (SHOTS) {
    await fs.mkdir(SHOTS, { recursive: true });
    for (const width of [520, 760, 1100]) {
      win.setSize(width, 720);
      await sleep(250);
      await fs.writeFile(path.join(SHOTS, `home-settings-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    win.setSize(1100, 720);
    await sleep(250);
    await win.webContents.executeJavaScript(`document.getElementById("settings-assistant-wake").scrollIntoView({ block: "center" })`);
    await sleep(250);
    await fs.writeFile(path.join(SHOTS, "home-settings-assistant.png"), (await win.webContents.capturePage()).toPNG());
  }
  await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  await sleep(50);
  record("Escape leaves settings before it closes the window",
    (await win.webContents.executeJavaScript(`window.__homeProbe.closed()`)) === 0 &&
    (await win.webContents.executeJavaScript(`document.getElementById("settings").hidden`)));
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
  win.webContents.send("marshal:assistant-state", dashboard("waiting"));
  await sleep(1000);
  await shootWidths(win, "home-light-overview");
  await shootFull(win, "home-light-full");
  win.webContents.send("marshal:assistant-state", { state: "listening", lang: "uk" });
  await sleep(1000);
  const lightToken = parseColor(await win.webContents.executeJavaScript(TOKEN_RGB("--text-muted")));
  const lightRibbon = (await win.webContents.executeJavaScript(RIBBON)).rgb;
  record("light theme redraws the canvas in light tokens", lightRibbon && lightToken && distance(lightRibbon, lightToken) < 120,
    lightRibbon ? `distance ${distance(lightRibbon, lightToken).toFixed(0)}` : "no ribbon pixels");

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
