// desktop/renderer/assistant-widget.js
//
// Mini assistant widget (#285). Main pushes the state and the "session needs
// you" cards; this file draws them. Click = skip the phrase being spoken,
// double-click = open the assistant home, drag = move. The visual stops after
// 30 s of idle (#281) and restarts on the next state change.

import { createHudVisual, normalizeState, parseRgb, stateLabel } from "./assistant-visual.js";

const api = window.marshalAssistant;
const widget = document.getElementById("widget");
const canvas = document.getElementById("visual");
const cardsList = document.getElementById("cards");

const IDLE_PAUSE_MS = 30_000;
const DRAG_THRESHOLD_PX = 4;
// A click waits this long for a second one, so a double-click does not also skip speech.
const CLICK_DELAY_MS = 250;

const t = (key) => window.MarshalI18n?.t(key) ?? key;
const lang = () => window.MarshalI18n?.language() ?? "en";
let state = "idle";
let idleTimer = 0;

const probe = document.createElement("span");
probe.style.display = "none";
document.body.append(probe);

function resolveColor(token) {
  probe.style.color = `var(${token})`;
  return parseRgb(getComputedStyle(probe).color) ?? [128, 128, 128];
}

const visual = createHudVisual(canvas, {
  resolveColor,
  getLevel: () => null,
  labelFor: (value) => stateLabel(value, lang()),
  footer: "",
  mini: true
});

function scheduleIdlePause() {
  clearTimeout(idleTimer);
  idleTimer = 0;
  if (state !== "idle") {
    visual.setPaused(false);
    return;
  }
  idleTimer = setTimeout(() => visual.setPaused(true), IDLE_PAUSE_MS);
}

function renderCards(cards) {
  cardsList.replaceChildren(
    ...cards.map((card) => {
      const item = document.createElement("li");
      item.className = "card";
      item.dataset.pid = String(card.pid);
      const name = document.createElement("b");
      name.textContent = card.name;
      const reason = document.createElement("small");
      reason.textContent = card.waitingFor || t("widget.waiting");
      item.title = `${card.name} — ${reason.textContent}`;
      item.append(name, reason);
      return item;
    })
  );
}

api.onState((_event, view) => {
  window.MarshalI18n?.set(view.lang);
  const next = normalizeState(view.state);
  const changed = next !== state;
  state = next;
  widget.dataset.state = state;
  canvas.title = t("widget.hint");
  canvas.setAttribute("aria-label", `${stateLabel(state, lang())}. ${t("widget.hint")}`);
  visual.setState(state);
  if (changed || !idleTimer) scheduleIdlePause();
  renderCards(Array.isArray(view.cards) ? view.cards : []);
});

cardsList.addEventListener("click", (event) => {
  const card = event.target.closest(".card");
  const pid = Number(card?.dataset.pid);
  if (Number.isInteger(pid)) void api.focusSession(pid);
});

// ── Drag, click, double-click on the visual ──
let drag = null;
let clickTimer = 0;
// The click that ends a drag is not a click on the widget.
let suppressClick = false;

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  suppressClick = false;
  canvas.setPointerCapture(event.pointerId);
  drag = { startX: event.screenX, startY: event.screenY, winX: window.screenX, winY: window.screenY, moved: false };
});

canvas.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const dx = event.screenX - drag.startX;
  const dy = event.screenY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
  drag.moved = true;
  void api.moveWidget(drag.winX + dx, drag.winY + dy, false);
});

canvas.addEventListener("pointerup", (event) => {
  if (!drag) return;
  const { moved, startX, startY, winX, winY } = drag;
  drag = null;
  if (!moved) return;
  suppressClick = true;
  void api.moveWidget(winX + event.screenX - startX, winY + event.screenY - startY, true);
});

// PointerEvent.detail is always 0 in Chromium: click counts come from click/dblclick.
canvas.addEventListener("click", (event) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (event.detail !== 1) return;
  clickTimer = setTimeout(() => {
    clickTimer = 0;
    void api.action("skip-speech");
  }, CLICK_DELAY_MS);
});

canvas.addEventListener("dblclick", () => {
  clearTimeout(clickTimer);
  clickTimer = 0;
  void api.action("open-home");
});

canvas.addEventListener("pointercancel", () => {
  drag = null;
});
