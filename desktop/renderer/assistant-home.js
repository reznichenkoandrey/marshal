// desktop/renderer/assistant-home.js
//
// Assistant home window (#284). Main pushes the state; this file only draws
// it and forwards dock clicks. The microphone is opened here, and only while
// the state is "listening", so the spectrum follows the user's voice without
// keeping an input stream alive the rest of the time (#281).

import { createHudVisual, normalizeState, parseRgb, stateLabel } from "./assistant-visual.js";
import { initSettings, openSettings } from "./settings-panel.js";

const api = window.marshalAssistant;
const home = document.getElementById("home");
const chip = document.getElementById("state-chip");
const line = document.getElementById("assistant-line");
const strip = document.getElementById("strip");
const canvas = document.getElementById("visual");
const sessionsList = document.getElementById("sessions");
const sessionsEmpty = document.getElementById("sessions-empty");
const recentList = document.getElementById("recent");

const t = (key, params) => window.MarshalI18n?.t(key, params) ?? key;
const lang = () => window.MarshalI18n?.language() ?? "en";
const HINT_STATES = new Set(["idle", "listening", "thinking", "working", "waiting", "offline"]);
const SESSION_STATUSES = new Set(["busy", "waiting", "shell", "idle"]);
const DOCK_TITLES = {
  translator: "home.dock.translator",
  captions: "home.dock.captions",
  "record-call": "home.dock.recordCall",
  "dictate-session": "home.dock.dictateSession",
  recordings: "home.dock.recordings",
  capture: "home.dock.capture",
  "dispatcher-terminal": "home.dock.dispatcherTerminal",
  settings: "home.dock.settings"
};
// Dock buttons light while their feature runs (#341); the mic follows the state colour.
const DOCK_ACTIVE = { translator: "translator", captions: "captions", "record-call": "recording" };

let state = "idle";
let lines = [];
let groups = [];
let stripView = null;
let countdown = 0;
const MEMORY_CELLS = 10;
const COUNTDOWN_MS = 30_000;
// The user's own speech gets its guidance; otherwise the last thing Marshal said.
const HINT_FIRST = new Set(["listening", "thinking", "offline"]);

// ── Colour tokens → rgb for the canvas ──
const probe = document.createElement("span");
probe.style.display = "none";
document.body.append(probe);

function resolveColor(token) {
  probe.style.color = `var(${token})`;
  return parseRgb(getComputedStyle(probe).color) ?? [128, 128, 128];
}

// ── Microphone level, only while listening ──
const mic = { stream: null, analyser: null, context: null, buffer: null, opening: false };

async function openMic() {
  if (mic.stream || mic.opening) return;
  mic.opening = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (state !== "listening") {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    Object.assign(mic, { stream, analyser, context, buffer: new Float32Array(analyser.fftSize) });
  } catch {
    // No microphone for the renderer: the visual falls back to its ambient level.
  } finally {
    mic.opening = false;
  }
}

function closeMic() {
  mic.stream?.getTracks().forEach((track) => track.stop());
  void mic.context?.close().catch(() => undefined);
  Object.assign(mic, { stream: null, analyser: null, context: null, buffer: null });
}

function micLevel() {
  if (!mic.analyser) return null;
  mic.analyser.getFloatTimeDomainData(mic.buffer);
  let sum = 0;
  for (const sample of mic.buffer) sum += sample * sample;
  const rms = Math.sqrt(sum / mic.buffer.length);
  // Speech sits around 0.02–0.2 RMS; a square root spreads it over the dial.
  return Math.min(1, Math.sqrt(rms * 6));
}

const visual = createHudVisual(canvas, {
  resolveColor,
  getLevel: () => (state === "listening" ? micLevel() : null),
  labelFor: (value) => stateLabel(value, lang()),
  footer: "VOX · UK/EN"
});

// ── Rendering ──
function applyTitles() {
  document.querySelectorAll(".dock [data-action]").forEach((button) => {
    const key = DOCK_TITLES[button.dataset.action];
    const on = button.classList.contains("on");
    const title = key ? (on ? `${t(key)} · ${t("home.on")}` : t(key)) : "";
    button.title = title;
    button.setAttribute("aria-label", title);
  });
  const close = document.getElementById("close-btn");
  close.title = t("home.close");
  close.setAttribute("aria-label", t("home.close"));
}

function render() {
  home.dataset.state = state;
  chip.textContent = stateLabel(state, lang());
  const hint = HINT_STATES.has(state) ? t(`home.hint.${state}`) : "";
  line.textContent = HINT_FIRST.has(state) ? hint || lines[0] || "" : lines[0] || hint;
  visual.setState(state);
  if (state === "listening") void openMic();
  else closeMic();
}

function renderSide() {
  document.getElementById("sessions-title").textContent = t("home.sessions");
  document.getElementById("recent-title").textContent = t("home.recent");
  sessionsEmpty.textContent = groups.length ? "" : t("home.noSessions");
  sessionsList.replaceChildren(
    ...groups.flatMap(({ project, sessions }) => [
      Object.assign(document.createElement("li"), { className: "project", textContent: project }),
      ...sessions.map((session) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "session";
        button.dataset.pid = String(session.pid);
        button.dataset.status = session.status ?? "idle";
        const tag = t(`home.status.${SESSION_STATUSES.has(session.status) ? session.status : "idle"}`);
        button.title = session.waitingFor ? `${session.name} — ${session.waitingFor}` : session.name;
        const dot = Object.assign(document.createElement("span"), { className: "dot" });
        const label = document.createElement("span");
        label.append(Object.assign(document.createElement("b"), { textContent: session.name }));
        if (session.waitingFor) label.append(Object.assign(document.createElement("small"), { textContent: session.waitingFor }));
        button.append(dot, label, Object.assign(document.createElement("span"), { className: "tag", textContent: tag }));
        item.append(button);
        return item;
      })
    ])
  );
  recentList.replaceChildren(...lines.map((value) => Object.assign(document.createElement("li"), { textContent: value })));
}

const SYMBOLS = { commandorcontrol: "⌘", cmdorctrl: "⌘", command: "⌘", cmd: "⌘", alt: "⌥", option: "⌥", shift: "⇧", control: "⌃", ctrl: "⌃" };

function hotkeyLabel(accelerator) {
  return accelerator.split("+").map((part) => SYMBOLS[part.toLowerCase()] ?? part.toUpperCase()).join("");
}

function meetingWhen(startIso, now = Date.now()) {
  const minutes = Math.ceil((Date.parse(startIso) - now) / 60_000);
  if (minutes <= 0) return t("home.meetingNow");
  return minutes < 60
    ? t("home.inMinutes", { minutes })
    : t("home.inHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

function renderStrip() {
  const view = stripView;
  strip.hidden = !view;
  if (!view) return;
  for (const [action, key] of Object.entries(DOCK_ACTIVE)) {
    document.querySelector(`.dock [data-action="${action}"]`)?.classList.toggle("on", Boolean(view.active?.[key]));
  }
  applyTitles();
  const speech = strip.querySelector('[data-action="toggle-speech"]');
  speech.setAttribute("aria-pressed", String(Boolean(view.speech)));
  speech.title = t("home.speechTitle");
  strip.querySelector('[data-label="speech"]').textContent = t("home.speech");
  const language = strip.querySelector('[data-action="toggle-language"]');
  language.textContent = lang().toUpperCase();
  language.title = t("home.langTitle");

  const mem = document.getElementById("mem");
  mem.hidden = !view.memory;
  if (view.memory) {
    const { usedMb, budgetMb } = view.memory;
    const lit = Math.min(MEMORY_CELLS, Math.round((usedMb / budgetMb) * MEMORY_CELLS));
    document.getElementById("batt").replaceChildren(
      ...Array.from({ length: MEMORY_CELLS }, (_, index) => Object.assign(document.createElement("i"), { className: index < lit ? "on" : "" }))
    );
    document.getElementById("mem-text").textContent = `mem ${usedMb}/${budgetMb}`;
    mem.classList.toggle("over", usedMb > budgetMb);
    mem.title = t("home.memTitle", { used: usedMb, budget: budgetMb });
  }

  const meeting = document.getElementById("meeting");
  meeting.hidden = !view.meeting;
  if (view.meeting) {
    document.getElementById("meeting-title").textContent = view.meeting.title;
    document.getElementById("meeting-when").textContent = meetingWhen(view.meeting.start);
    const join = document.getElementById("join");
    join.hidden = !view.meeting.joinable;
    join.textContent = t("home.join");
  }

  const hotkey = document.getElementById("hotkey");
  hotkey.hidden = !view.hotkey;
  if (view.hotkey) {
    hotkey.textContent = hotkeyLabel(view.hotkey);
    hotkey.title = t("home.hotkey");
  }
}

// The countdown ticks only while the window is visible and a meeting is shown.
function syncCountdown() {
  const wanted = Boolean(stripView?.meeting) && !document.hidden;
  if (wanted && !countdown) countdown = setInterval(renderStrip, COUNTDOWN_MS);
  if (!wanted && countdown) {
    clearInterval(countdown);
    countdown = 0;
  }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) renderStrip();
  syncCountdown();
});

// Main resolves the language for every window; the state payload carries it
// too, so the e2e stub (no i18n preload) still switches.
api?.onState((_event, payload) => {
  window.MarshalI18n?.set(payload.lang);
  if (Array.isArray(payload.lines)) lines = payload.lines.filter((value) => typeof value === "string");
  if (Array.isArray(payload.sessions)) groups = payload.sessions;
  state = normalizeState(payload.state);
  if (payload.strip) stripView = payload.strip;
  render();
  renderSide();
  renderStrip();
  syncCountdown();
});

sessionsList.addEventListener("click", async (event) => {
  const button = event.target.closest(".session");
  if (!button) return;
  const result = await api?.focusSession(Number(button.dataset.pid)).catch((err) => ({ ok: false, error: String(err) }));
  // "app": only the host app came forward (Claude desktop, an IDE), showing whatever it had open (#337).
  const note = !result ? "" : !result.ok ? `${t("home.focusFailed")}: ${result.error}` : result.focused === "app" ? t("home.focusedApp") : "";
  if (note) {
    lines = [note, ...lines].slice(0, 5);
    render();
    renderSide();
  }
});

for (const area of [document.querySelector(".dock"), strip]) {
  area.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    // Settings are a view of this window, not another window (#317).
    if (button.dataset.action === "settings") toggleSettings();
    else void api?.action(button.dataset.action);
  });
}

// ── Settings view (#317) ──

const settingsView = document.getElementById("settings");
const settingsScroll = document.getElementById("settings-form");
const rail = document.getElementById("settings-rail");

function settingsOpen() {
  return home.dataset.view === "settings";
}

function showSettings() {
  if (!settingsOpen()) {
    home.dataset.view = "settings";
    settingsView.hidden = false;
    void openSettings();
  }
}

function hideSettings() {
  delete home.dataset.view;
  settingsView.hidden = true;
}

function toggleSettings() {
  if (settingsOpen()) hideSettings();
  else showSettings();
}

function markSection(key) {
  rail.querySelectorAll(".rail-btn").forEach((button) => {
    button.setAttribute("aria-current", String(button.dataset.section === key));
  });
}

rail.addEventListener("click", (event) => {
  const button = event.target.closest(".rail-btn");
  if (!button) return;
  document.getElementById(`settings-sec-${button.dataset.section}`)?.scrollIntoView({ block: "start" });
  markSection(button.dataset.section);
});

// The rail follows scrolling: the last section whose top has passed the view's top.
settingsScroll.addEventListener("scroll", () => {
  const top = settingsScroll.getBoundingClientRect().top + 24;
  let current = "appearance";
  for (const section of settingsScroll.querySelectorAll(".settings-section")) {
    if (section.getBoundingClientRect().top <= top) current = section.dataset.section;
  }
  markSection(current);
}, { passive: true });

// Enter in a field must not submit the form and reload the window.
settingsScroll.addEventListener("submit", (event) => event.preventDefault());
initSettings({ close: hideSettings });
markSection("appearance");
document.getElementById("settings-back").addEventListener("click", hideSettings);
api?.onShowSettings?.(() => showSettings());

document.getElementById("close-btn").addEventListener("click", () => void api?.close());
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  // Escape leaves settings first; a second one closes the window.
  if (settingsOpen()) hideSettings();
  else void api?.close();
});

// The palette or light/dark can change while the window is open.
new MutationObserver(() => visual.refreshColors()).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme", "data-look", "data-palette"]
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => visual.refreshColors());

window.MarshalIcons?.apply();
applyTitles();
render();
renderSide();
renderStrip();
visual.start();

window.addEventListener("marshal:language", () => {
  applyTitles();
  render();
  renderSide();
  renderStrip();
});
