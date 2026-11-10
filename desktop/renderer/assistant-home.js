// desktop/renderer/assistant-home.js
//
// Assistant home window (#284). Main pushes the state; this file only draws
// it and forwards dock clicks. The microphone is opened here, and only while
// the state is "listening", so the spectrum follows the user's voice without
// keeping an input stream alive the rest of the time (#281).

import { createHudVisual, normalizeState, parseRgb, stateLabel } from "./assistant-visual.js";

const api = window.marshalAssistant;
const home = document.getElementById("home");
const chip = document.getElementById("state-chip");
const line = document.getElementById("assistant-line");
const telemetry = document.getElementById("telemetry");
const canvas = document.getElementById("visual");
const sessionsList = document.getElementById("sessions");
const sessionsEmpty = document.getElementById("sessions-empty");
const recentList = document.getElementById("recent");

const HINTS = {
  uk: {
    idle: "Натисни мікрофон і скажи команду для сесії Claude Code",
    listening: "Слухаю… натисни ще раз, щоб надіслати",
    thinking: "Розпізнаю сказане",
    speaking: "",
    working: "Сесії працюють",
    waiting: "Сесія чекає на тебе",
    offline: "Розпізнавання мовлення недоступне — перевір Settings → Dictation"
  },
  en: {
    idle: "Press the mic and say a command for a Claude Code session",
    listening: "Listening… press again to send",
    thinking: "Recognising what you said",
    speaking: "",
    working: "Sessions are working",
    waiting: "A session needs you",
    offline: "Speech recognition is unavailable — check Settings → Dictation"
  }
};

const TEXT = {
  uk: {
    sessions: "Сесії Claude Code",
    recent: "Останнє",
    noSessions: "Немає живих сесій",
    status: { busy: "працює", waiting: "чекає", shell: "shell", idle: "вільна" },
    focusFailed: "Не вдалося відкрити сесію"
  },
  en: {
    sessions: "Claude Code sessions",
    recent: "Recent",
    noSessions: "No live sessions",
    status: { busy: "working", waiting: "waiting", shell: "shell", idle: "idle" },
    focusFailed: "Could not open the session"
  }
};

const TITLES = {
  uk: {
    translator: "Перекладач",
    captions: "Живі субтитри",
    "record-call": "Записати дзвінок",
    "dictate-session": "Сказати команду сесії",
    recordings: "Записи дзвінків",
    capture: "Знімок екрана",
    agent: "Чат агента",
    settings: "Налаштування",
    close: "Закрити"
  },
  en: {
    translator: "Translator",
    captions: "Live captions",
    "record-call": "Record a call",
    "dictate-session": "Say a command to a session",
    recordings: "Call recordings",
    capture: "Screen capture",
    agent: "Agent chat",
    settings: "Settings",
    close: "Close"
  }
};

let lang = "en";
let state = "idle";
let lines = [];
let groups = [];
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
  labelFor: (value) => stateLabel(value, lang),
  footer: "VOX · UK/EN"
});

// ── Rendering ──
function applyTitles() {
  const titles = TITLES[lang] ?? TITLES.en;
  document.querySelectorAll("[data-action]").forEach((button) => {
    const title = titles[button.dataset.action] ?? "";
    button.title = title;
    button.setAttribute("aria-label", title);
  });
  const close = document.getElementById("close-btn");
  close.title = titles.close;
  close.setAttribute("aria-label", titles.close);
}

function render() {
  home.dataset.state = state;
  chip.textContent = stateLabel(state, lang);
  const hint = (HINTS[lang] ?? HINTS.en)[state] || "";
  line.textContent = HINT_FIRST.has(state) ? hint || lines[0] || "" : lines[0] || hint;
  visual.setState(state);
  if (state === "listening") void openMic();
  else closeMic();
}

function text() {
  return TEXT[lang] ?? TEXT.en;
}

function renderSide() {
  const t = text();
  document.getElementById("sessions-title").textContent = t.sessions;
  document.getElementById("recent-title").textContent = t.recent;
  sessionsEmpty.textContent = groups.length ? "" : t.noSessions;
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
        const tag = t.status[session.status] ?? t.status.idle;
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

function renderTelemetry(items) {
  telemetry.replaceChildren(
    ...(items ?? []).map(({ label, value }) => {
      const span = document.createElement("span");
      const bold = document.createElement("b");
      span.append(`${label} `);
      bold.textContent = value;
      span.append(bold);
      return span;
    })
  );
}

api?.onState((_event, payload) => {
  if (payload.lang === "uk" || payload.lang === "en") {
    if (payload.lang !== lang) {
      lang = payload.lang;
      document.documentElement.lang = lang;
      applyTitles();
    }
  }
  if (Array.isArray(payload.lines)) lines = payload.lines.filter((value) => typeof value === "string");
  if (Array.isArray(payload.sessions)) groups = payload.sessions;
  state = normalizeState(payload.state);
  if (payload.telemetry) renderTelemetry(payload.telemetry);
  render();
  renderSide();
});

sessionsList.addEventListener("click", async (event) => {
  const button = event.target.closest(".session");
  if (!button) return;
  const result = await api?.focusSession(Number(button.dataset.pid));
  if (result && !result.ok) {
    lines = [`${text().focusFailed}: ${result.error}`, ...lines].slice(0, 5);
    render();
    renderSide();
  }
});

document.querySelector(".dock").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button) void api?.action(button.dataset.action);
});
document.getElementById("close-btn").addEventListener("click", () => void api?.close());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void api?.close();
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
visual.start();
