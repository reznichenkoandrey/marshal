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
const HINT_STATES = new Set(["idle", "listening", "thinking", "working", "waiting", "offline", "sleeping"]);
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
let features = [];
let commands = null;
let range = 1;
let updatedAt = Date.now();
let countdown = 0;
const MEMORY_CELLS = 10;
const COUNTDOWN_MS = 30_000;
// The user's own speech gets its guidance; otherwise the last thing Marshal said.
const HINT_FIRST = new Set(["listening", "thinking", "offline", "sleeping"]);

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
  labelFor: (value) => stateLabel(value, lang())
});

// ── Rendering ──
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function applyTitles() {
  document.querySelectorAll(".dock [data-action], .strip .mic").forEach((button) => {
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

function sessionButton(session) {
  const button = el("button", "session");
  button.type = "button";
  button.dataset.pid = String(session.pid);
  button.dataset.status = session.status ?? "idle";
  const tag = t(`home.status.${SESSION_STATUSES.has(session.status) ? session.status : "idle"}`);
  button.title = session.waitingFor ? `${session.name} — ${session.waitingFor}` : session.name;
  const label = el("span");
  label.append(el("b", "", session.name));
  if (session.waitingFor) label.append(el("small", "", session.waitingFor));
  button.append(el("span", "dot"), label, el("span", "tag", tag));
  return button;
}

// Waiting sessions are the alerts that block work; what Marshal said is info.
function alerts() {
  const waiting = groups.flatMap(({ sessions }) => sessions).filter((session) => session.status === "waiting");
  return [
    ...waiting.map((session) => {
      const permission = /permission|дозв/i.test(session.waitingFor ?? "");
      return {
        level: permission ? "critical" : "warning",
        title: t(permission ? "home.alert.permission" : "home.alert.answer", { name: session.name }),
        sub: session.waitingFor ?? ""
      };
    }),
    ...lines.map((value) => ({ level: "info", title: value, sub: "" }))
  ];
}

function renderSide() {
  document.getElementById("sessions-title").textContent = t("home.sessions");
  document.getElementById("recent-title").textContent = t("home.recent");
  sessionsEmpty.textContent = groups.length ? "" : t("home.noSessions");
  sessionsList.replaceChildren(
    ...groups.flatMap(({ project, sessions }) => [
      el("li", "project", project),
      ...sessions.map((session) => {
        const item = el("li");
        item.append(sessionButton(session));
        return item;
      })
    ])
  );
  const items = alerts();
  recentList.replaceChildren(
    ...items.map(({ level, title, sub }) => {
      const item = el("li");
      item.dataset.level = level;
      item.append(el("span", "level", t(`home.alert.${level}`)), el("b", "", title));
      if (sub) item.append(el("small", "", sub));
      return item;
    })
  );
  if (!items.length) recentList.append(el("li", "none", t("home.noAlerts")));
  const urgent = items.filter((item) => item.level !== "info").length;
  const count = document.getElementById("recent-count");
  count.textContent = items.length ? String(urgent || items.length) : "";
  count.dataset.urgent = String(urgent > 0);
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

// "1h 05m" / "12m" / "now" — the big numeral of the meeting metric.
function untilLabel(startIso, now = Date.now()) {
  const minutes = Math.ceil((Date.parse(startIso) - now) / 60_000);
  if (minutes <= 0) return t("home.meetingNow");
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function clockLabel(iso) {
  return new Date(iso).toLocaleTimeString(lang() === "uk" ? "uk-UA" : "en-GB", { hour: "2-digit", minute: "2-digit" });
}

function setMetric(name, value, label, delta) {
  const metric = document.querySelector(`.metric[data-metric="${name}"]`);
  metric.querySelector(".num").textContent = value;
  const labelNode = metric.querySelector(".label");
  labelNode.replaceChildren(document.createTextNode(label));
  if (delta) labelNode.append(el("span", "delta", delta));
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function renderMetrics() {
  const all = groups.flatMap(({ sessions }) => sessions);
  const waiting = all.filter((session) => session.status === "waiting").length;
  setMetric("sessions", String(all.length), t("home.metric.sessions", { waiting }));

  const counts = commands ? (range === 7 ? commands.week : commands.day) : null;
  setMetric(
    "commands",
    counts ? String(counts.current) : "–",
    t(range === 7 ? "home.metric.commandsWeek" : "home.metric.commandsDay"),
    counts ? `${signed(counts.current - counts.previous)} ${t(range === 7 ? "home.vsLastWeek" : "home.vsYesterday")}` : ""
  );

  const memory = stripView?.memory;
  setMetric(
    "memory",
    memory ? String(memory.usedMb) : "–",
    memory ? t("home.metric.memory", { budget: memory.budgetMb }) : t("home.metric.memoryUnknown")
  );
  document.querySelector('.metric[data-metric="memory"]').classList.toggle("over", Boolean(memory && memory.usedMb > memory.budgetMb));

  const meeting = stripView?.meeting;
  setMetric("meeting", meeting ? untilLabel(meeting.start) : "–", meeting ? t("home.metric.meeting", { title: meeting.title }) : t("home.metric.noMeeting"));
}

function renderUpdated() {
  const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  const node = document.getElementById("updated");
  node.textContent = seconds < 60 ? t("home.updated", { seconds }) : t("home.updatedMinutes", { minutes: Math.floor(seconds / 60) });
}

function renderStrip() {
  const view = stripView;
  for (const [action, key] of Object.entries(DOCK_ACTIVE)) {
    document.querySelector(`.dock [data-action="${action}"]`)?.classList.toggle("on", Boolean(view?.active?.[key]));
  }
  applyTitles();
  const speech = strip.querySelector('[data-action="toggle-speech"]');
  speech.setAttribute("aria-pressed", String(Boolean(view?.speech)));
  speech.title = t("home.speechTitle");
  strip.querySelector('[data-label="speech"]').textContent = t("home.speech");
  const language = strip.querySelector('[data-action="toggle-language"]');
  language.textContent = lang().toUpperCase();
  language.title = t("home.langTitle");
  renderUpdated();
  renderMetrics();

  const mem = document.getElementById("mem");
  mem.hidden = !view?.memory;
  if (view?.memory) {
    const { usedMb, budgetMb, split = [] } = view.memory;
    const lit = Math.min(MEMORY_CELLS, Math.round((usedMb / budgetMb) * MEMORY_CELLS));
    document.getElementById("batt").replaceChildren(
      ...Array.from({ length: MEMORY_CELLS }, (_, index) => el("i", index < lit ? "on" : ""))
    );
    document.getElementById("mem-used").textContent = String(usedMb);
    document.getElementById("mem-budget").textContent = `/ ${budgetMb} MB`;
    document.getElementById("mem-text").textContent = t("home.memMeasured");
    mem.classList.toggle("over", usedMb > budgetMb);
    mem.title = t("home.memTitle", { used: usedMb, budget: budgetMb });
    document.getElementById("mem-split").replaceChildren(
      ...split.map(({ group, mb }) => {
        const item = el("li");
        item.dataset.group = group;
        const bar = el("span", "meter");
        bar.style.setProperty("--share", String(Math.min(1, mb / Math.max(1, usedMb))));
        item.append(el("span", "name", t(`home.memSplit.${group}`)), bar, el("span", "mb", `${mb} MB`));
        return item;
      })
    );
  }

  const meeting = document.getElementById("meeting");
  meeting.hidden = !view?.meeting;
  if (view?.meeting) {
    document.getElementById("meeting-time").textContent = clockLabel(view.meeting.start);
    document.getElementById("meeting-when").textContent = meetingWhen(view.meeting.start);
    document.getElementById("meeting-title").textContent = view.meeting.title;
    const join = document.getElementById("join");
    join.hidden = !view.meeting.joinable;
    join.textContent = t("home.join");
  }

  const hotkey = document.getElementById("hotkey");
  hotkey.hidden = !view?.hotkey;
  if (view?.hotkey) {
    hotkey.textContent = hotkeyLabel(view.hotkey);
    hotkey.title = t("home.hotkey");
  }
}

const FEATURE_ICONS = { dictation: "mic", captions: "captions", translator: "languages", speech: "message-square", calendar: "calendar" };

function featureStats(card) {
  if (card.id === "calendar") return [card.stats[0] && card.stats[0] !== "–" ? clockLabel(card.stats[0]) : "–"];
  return card.stats;
}

function renderFeatures() {
  const box = document.getElementById("features");
  box.replaceChildren(
    ...features.map((card) => {
      const node = el("article", "feature");
      node.dataset.state = card.state;
      node.dataset.feature = card.id;
      const ring = el("span", "ring");
      ring.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="18"/></svg>';
      const body = el("div", "feature-body");
      const chipNode = el("span", "fchip", t(`home.featureState.${card.state}`));
      body.append(chipNode, el("h4", "", t(`home.feature.${card.id}`)), el("p", "", t(`home.feature.${card.id}Desc`)));
      const foot = el("footer", "feature-foot");
      const stats = featureStats(card);
      const icon = el("span", "feature-icon");
      icon.dataset.icon = FEATURE_ICONS[card.id];
      icon.dataset.iconSize = "14";
      foot.append(icon, el("span", "stat", stats[0] ?? ""), el("span", "stat", stats.slice(1).join(" · ")));
      node.append(ring, body, foot);
      return node;
    })
  );
  window.MarshalIcons?.apply(box);
  const ready = features.filter((card) => card.state === "ready" || card.state === "running").length;
  document.getElementById("features-note").textContent = features.length ? t("home.featuresReady", { ready, total: features.length }) : "";
}

function durationLabel(ms) {
  if (ms === null || ms === undefined) return "–";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function renderCommands() {
  const rows = commands?.rows ?? [];
  document.getElementById("commands-empty").textContent = rows.length ? "" : t("home.noCommands");
  document.querySelector("table.commands").hidden = !rows.length;
  document.getElementById("commands").replaceChildren(
    ...rows.map((row) => {
      const tr = el("tr");
      tr.dataset.outcome = row.outcome;
      const said = el("td", "said");
      said.append(el("span", "time", clockLabel(new Date(row.at).toISOString())), el("q", "", row.text));
      const routed = el("td", "routed", row.target ?? "–");
      if (row.kind) routed.dataset.kind = row.kind;
      const outcome = el("td");
      outcome.append(el("span", "ochip", t(`home.outcome.${row.outcome}`)));
      tr.append(said, routed, outcome, el("td", "right mono", durationLabel(row.durationMs)));
      return tr;
    })
  );
}

// One renderer-side tick while the window is visible: "updated Ns ago" and the meeting countdown.
function syncCountdown() {
  const wanted = !document.hidden;
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
  if (Array.isArray(payload.features)) features = payload.features;
  if (payload.commands) commands = payload.commands;
  state = normalizeState(payload.state);
  if (payload.strip) stripView = payload.strip;
  updatedAt = Date.now();
  render();
  renderSide();
  renderStrip();
  renderFeatures();
  renderCommands();
  syncCountdown();
});

document.getElementById("range").addEventListener("click", (event) => {
  const button = event.target.closest("[data-range]");
  if (!button) return;
  range = Number(button.dataset.range);
  document.querySelectorAll("#range [data-range]").forEach((node) => node.setAttribute("aria-selected", String(node === button)));
  renderMetrics();
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

for (const area of [document.querySelector(".dock"), document.querySelector(".dash"), document.querySelector(".side")]) {
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

const tabs = document.querySelector(".tabs");

function syncTabs() {
  const current = settingsOpen() ? "settings" : "home";
  tabs.querySelectorAll(".tab").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.tab === current)));
}

function showSettings() {
  if (!settingsOpen()) {
    home.dataset.view = "settings";
    settingsView.hidden = false;
    syncTabs();
    void openSettings();
  }
}

function hideSettings() {
  delete home.dataset.view;
  settingsView.hidden = true;
  syncTabs();
}

tabs.addEventListener("click", (event) => {
  const tab = event.target.closest(".tab");
  if (!tab) return;
  if (tab.dataset.tab === "settings") showSettings();
  else hideSettings();
});

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
renderFeatures();
renderCommands();
syncCountdown();
visual.start();

window.addEventListener("marshal:language", () => {
  applyTitles();
  render();
  renderSide();
  renderStrip();
  renderFeatures();
  renderCommands();
});
