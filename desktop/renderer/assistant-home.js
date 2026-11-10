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
let assistantLine = "";

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
  line.textContent = assistantLine || (HINTS[lang] ?? HINTS.en)[state] || "";
  visual.setState(state);
  if (state === "listening") void openMic();
  else closeMic();
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
  state = normalizeState(payload.state);
  assistantLine = typeof payload.line === "string" ? payload.line : "";
  if (payload.telemetry) renderTelemetry(payload.telemetry);
  render();
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
visual.start();
