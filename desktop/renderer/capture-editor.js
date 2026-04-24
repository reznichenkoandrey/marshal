// desktop/renderer/capture-editor.js
//
// Capture annotation editor — vanilla JS canvas. Single-file module keeps the
// shape draw loop close to the event handlers for easier tracing.
//
// Model:
//   state.base          → HTMLImageElement (captured PNG)
//   state.shapes        → committed annotations (rendered every frame)
//   state.draft         → in-progress shape while the pointer is down
//   state.history       → undo stack of shape-array snapshots
//   state.future        → redo stack
//
// Canvas layers:
//   #base-canvas        → static captured image (redrawn only after crop)
//   #draw-canvas        → shapes + draft (redrawn on every model change)

const api = window.marshalCapture;

// Native pixel size of the captured image. Set on image-loaded and after crop.
const state = {
  base: null,
  baseW: 0,
  baseH: 0,
  shapes: [],
  draft: null,
  history: [],
  future: [],
  tool: "rect",
  strokeColor: "#e5484d",
  strokeWidth: 4,
  zoom: 1,
  counter: 1
};

const els = {
  viewport: document.getElementById("viewport"),
  canvasWrap: document.getElementById("canvas-wrap"),
  base: document.getElementById("base-canvas"),
  draw: document.getElementById("draw-canvas"),
  textInput: document.getElementById("text-input"),
  zoomLabel: document.getElementById("zoom-label"),
  toast: document.getElementById("toast"),
  strokeColor: document.getElementById("stroke-color"),
  strokeChip: document.getElementById("stroke-chip")
};

const baseCtx = els.base.getContext("2d");
const drawCtx = els.draw.getContext("2d");

// ── Image ingress ───────────────────────────────────────────────────────────

api.onImageLoaded((_event, payload) => {
  const img = new Image();
  img.onload = () => {
    state.base = img;
    state.baseW = img.naturalWidth;
    state.baseH = img.naturalHeight;
    resizeCanvases();
    fitToWindow();
    renderBase();
    renderDraw();
  };
  img.src = `data:image/png;base64,${payload.base64}`;
});

function resizeCanvases() {
  els.base.width = state.baseW;
  els.base.height = state.baseH;
  els.draw.width = state.baseW;
  els.draw.height = state.baseH;
  els.canvasWrap.style.width = `${state.baseW}px`;
  els.canvasWrap.style.height = `${state.baseH}px`;
  applyZoom();
}

function renderBase() {
  if (!state.base) return;
  baseCtx.clearRect(0, 0, state.baseW, state.baseH);
  baseCtx.drawImage(state.base, 0, 0);
}

function renderDraw() {
  drawCtx.clearRect(0, 0, state.baseW, state.baseH);
  for (const shape of state.shapes) drawShape(drawCtx, shape);
  if (state.draft) drawShape(drawCtx, state.draft);
}

// ── Shape drawing ───────────────────────────────────────────────────────────

function drawShape(ctx, s) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  switch (s.type) {
    case "rect":
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      break;
    case "rect-fill":
      ctx.globalAlpha = 0.35;
      ctx.fillRect(s.x, s.y, s.w, s.h);
      break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w) / 2, Math.abs(s.h) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "line":
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
      break;
    case "arrow":
      drawArrow(ctx, s.x, s.y, s.x2, s.y2, s.width);
      break;
    case "pen":
      if (s.points.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.stroke();
      break;
    case "text":
      ctx.font = `${Math.max(14, s.width * 6)}px var(--font-sans)`;
      ctx.textBaseline = "top";
      for (let i = 0; i < s.lines.length; i++) {
        ctx.fillText(s.lines[i], s.x, s.y + i * Math.max(18, s.width * 7));
      }
      break;
    case "counter":
      drawCounter(ctx, s);
      break;
    case "blur":
      drawBlur(ctx, s);
      break;
  }

  ctx.restore();
}

function drawArrow(ctx, x1, y1, x2, y2, lw) {
  const head = Math.max(10, lw * 3);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

function drawCounter(ctx, s) {
  const r = Math.max(14, s.width * 4);
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#fff";
  ctx.font = `700 ${Math.round(r * 1.1)}px -apple-system, "SF Pro Text", Inter, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(s.value), s.x, s.y + 1);
}

// Pixelate the underlying area of the base canvas so the blur shape persists
// across re-renders. We sample from the original base image, not the current
// draw layer, so annotations underneath stay annotated.
function drawBlur(ctx, s) {
  if (!state.base) return;
  const block = Math.max(8, Math.round(Math.min(Math.abs(s.w), Math.abs(s.h)) / 20));
  const sx = Math.min(s.x, s.x + s.w);
  const sy = Math.min(s.y, s.y + s.h);
  const sw = Math.abs(s.w);
  const sh = Math.abs(s.h);
  if (sw < 2 || sh < 2) return;

  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.round(sw / block));
  off.height = Math.max(1, Math.round(sh / block));
  const offCtx = off.getContext("2d");
  offCtx.imageSmoothingEnabled = false;
  offCtx.drawImage(state.base, sx, sy, sw, sh, 0, 0, off.width, off.height);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, off.width, off.height, sx, sy, sw, sh);
  ctx.restore();
}

// ── History ─────────────────────────────────────────────────────────────────

function snapshot() {
  state.history.push(JSON.stringify(state.shapes));
  if (state.history.length > 50) state.history.shift();
  state.future.length = 0;
}

function undo() {
  if (state.history.length === 0) return;
  state.future.push(JSON.stringify(state.shapes));
  state.shapes = JSON.parse(state.history.pop());
  renderDraw();
}

function redo() {
  if (state.future.length === 0) return;
  state.history.push(JSON.stringify(state.shapes));
  state.shapes = JSON.parse(state.future.pop());
  renderDraw();
}

// ── Pointer → canvas coords ─────────────────────────────────────────────────

function toCanvas(event) {
  const rect = els.canvasWrap.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / state.zoom,
    y: (event.clientY - rect.top) / state.zoom
  };
}

// ── Drawing state machine ───────────────────────────────────────────────────

let pointerActive = false;
let pointerStart = null;

els.draw.addEventListener("pointerdown", (e) => {
  if (state.tool === "text") {
    startTextInput(e);
    return;
  }

  if (state.tool === "counter") {
    const p = toCanvas(e);
    snapshot();
    state.shapes.push({
      type: "counter",
      x: p.x,
      y: p.y,
      value: state.counter++,
      color: state.strokeColor,
      width: state.strokeWidth
    });
    renderDraw();
    return;
  }

  if (state.tool === "crop") {
    pointerStart = toCanvas(e);
    state.draft = { type: "rect", x: pointerStart.x, y: pointerStart.y, w: 0, h: 0, color: "#4d9aff", width: 2 };
    pointerActive = true;
    els.draw.setPointerCapture(e.pointerId);
    return;
  }

  pointerStart = toCanvas(e);
  pointerActive = true;
  els.draw.setPointerCapture(e.pointerId);

  const base = {
    type: state.tool,
    color: state.strokeColor,
    width: state.strokeWidth
  };

  if (state.tool === "pen") {
    state.draft = { ...base, points: [{ x: pointerStart.x, y: pointerStart.y }] };
  } else if (state.tool === "line" || state.tool === "arrow") {
    state.draft = { ...base, x: pointerStart.x, y: pointerStart.y, x2: pointerStart.x, y2: pointerStart.y };
  } else {
    state.draft = { ...base, x: pointerStart.x, y: pointerStart.y, w: 0, h: 0 };
  }

  renderDraw();
});

els.draw.addEventListener("pointermove", (e) => {
  if (!pointerActive || !state.draft) return;
  const p = toCanvas(e);

  if (state.draft.type === "pen") {
    state.draft.points.push({ x: p.x, y: p.y });
  } else if (state.draft.type === "line" || state.draft.type === "arrow") {
    state.draft.x2 = p.x;
    state.draft.y2 = p.y;
  } else {
    state.draft.w = p.x - pointerStart.x;
    state.draft.h = p.y - pointerStart.y;
  }
  renderDraw();
});

els.draw.addEventListener("pointerup", (e) => {
  if (!pointerActive || !state.draft) return;
  pointerActive = false;
  els.draw.releasePointerCapture(e.pointerId);

  if (state.tool === "crop") {
    const c = state.draft;
    state.draft = null;
    if (Math.abs(c.w) > 8 && Math.abs(c.h) > 8) {
      applyCrop(c);
    } else {
      renderDraw();
    }
    return;
  }

  // Normalize rect-like shapes so width/height are positive.
  if (state.draft.type === "rect" || state.draft.type === "rect-fill" || state.draft.type === "ellipse" || state.draft.type === "blur") {
    if (state.draft.w < 0) { state.draft.x += state.draft.w; state.draft.w = -state.draft.w; }
    if (state.draft.h < 0) { state.draft.y += state.draft.h; state.draft.h = -state.draft.h; }
  }

  // Drop no-ops (single-point taps for region tools).
  const isTinyRect =
    (state.draft.type === "rect" || state.draft.type === "rect-fill" || state.draft.type === "ellipse" || state.draft.type === "blur") &&
    (state.draft.w < 3 || state.draft.h < 3);
  const isTinyLine =
    (state.draft.type === "line" || state.draft.type === "arrow") &&
    Math.hypot(state.draft.x2 - state.draft.x, state.draft.y2 - state.draft.y) < 4;
  const isTinyPen = state.draft.type === "pen" && state.draft.points.length < 3;

  if (!(isTinyRect || isTinyLine || isTinyPen)) {
    snapshot();
    state.shapes.push(state.draft);
  }
  state.draft = null;
  renderDraw();
});

function applyCrop(rect) {
  const sx = Math.min(rect.x, rect.x + rect.w);
  const sy = Math.min(rect.y, rect.y + rect.h);
  const sw = Math.abs(rect.w);
  const sh = Math.abs(rect.h);

  // Compose base + current shapes, then slice.
  const composite = document.createElement("canvas");
  composite.width = state.baseW;
  composite.height = state.baseH;
  const cctx = composite.getContext("2d");
  cctx.drawImage(els.base, 0, 0);
  cctx.drawImage(els.draw, 0, 0);

  const cropped = document.createElement("canvas");
  cropped.width = Math.round(sw);
  cropped.height = Math.round(sh);
  cropped.getContext("2d").drawImage(composite, sx, sy, sw, sh, 0, 0, sw, sh);

  // Replace the captured base with the cropped composite; clear annotations
  // (they're now baked in) and reset history.
  const img = new Image();
  img.onload = () => {
    state.base = img;
    state.baseW = cropped.width;
    state.baseH = cropped.height;
    state.shapes = [];
    state.history = [];
    state.future = [];
    resizeCanvases();
    fitToWindow();
    renderBase();
    renderDraw();
    setTool("select");
  };
  img.src = cropped.toDataURL("image/png");
}

// ── Text tool ──────────────────────────────────────────────────────────────

function startTextInput(event) {
  const p = toCanvas(event);
  const rect = els.canvasWrap.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;

  els.textInput.value = "";
  els.textInput.style.left = `${screenX}px`;
  els.textInput.style.top = `${screenY}px`;
  els.textInput.style.color = state.strokeColor;
  els.textInput.style.fontSize = `${Math.max(14, state.strokeWidth * 6) * state.zoom}px`;
  els.textInput.classList.remove("hidden");
  els.textInput.focus();

  const commit = () => {
    els.textInput.removeEventListener("blur", commit);
    els.textInput.removeEventListener("keydown", onKey);
    const raw = els.textInput.value.trim();
    els.textInput.classList.add("hidden");
    if (!raw) return;
    snapshot();
    state.shapes.push({
      type: "text",
      x: p.x,
      y: p.y,
      lines: raw.split("\n"),
      color: state.strokeColor,
      width: state.strokeWidth
    });
    renderDraw();
  };

  const onKey = (e) => {
    if (e.key === "Escape") {
      els.textInput.value = "";
      commit();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    }
  };

  els.textInput.addEventListener("blur", commit);
  els.textInput.addEventListener("keydown", onKey);
}

// ── Tools ──────────────────────────────────────────────────────────────────

function setTool(name) {
  state.tool = name;
  for (const btn of document.querySelectorAll(".tool[data-tool]")) {
    btn.classList.toggle("active", btn.dataset.tool === name);
  }
  els.draw.style.cursor = name === "text" ? "text" : "crosshair";
}

for (const btn of document.querySelectorAll(".tool[data-tool]")) {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
}
setTool("rect");

// Stroke width
for (const b of document.querySelectorAll(".stroke-w")) {
  b.addEventListener("click", () => {
    for (const x of document.querySelectorAll(".stroke-w")) x.classList.remove("active");
    b.classList.add("active");
    state.strokeWidth = Number(b.dataset.width);
  });
}

// Color picker
els.strokeColor.addEventListener("input", (e) => {
  state.strokeColor = e.target.value;
  els.strokeChip.style.background = state.strokeColor;
});

// Undo / redo
document.getElementById("undo").addEventListener("click", undo);
document.getElementById("redo").addEventListener("click", redo);

// ── Export ─────────────────────────────────────────────────────────────────

function composeForExport() {
  const out = document.createElement("canvas");
  out.width = state.baseW;
  out.height = state.baseH;
  const ctx = out.getContext("2d");
  ctx.drawImage(els.base, 0, 0);
  ctx.drawImage(els.draw, 0, 0);
  return out.toDataURL("image/png").replace(/^data:image\/\w+;base64,/u, "");
}

async function doSaveAs() {
  try {
    const b64 = composeForExport();
    const result = await api.saveAs(b64);
    if (result && result.path) toast(`Saved to ${result.path}`);
  } catch (err) {
    toast(`Save failed: ${err.message || err}`);
  }
}

async function doSaveQuick() {
  try {
    const b64 = composeForExport();
    const result = await api.saveQuick(b64);
    if (result && result.path) toast(`Saved: ${result.path.split("/").pop()}`);
  } catch (err) {
    toast(`Save failed: ${err.message || err}`);
  }
}

async function doCopy() {
  try {
    const b64 = composeForExport();
    await api.copy(b64);
    toast("Copied to clipboard");
  } catch (err) {
    toast(`Copy failed: ${err.message || err}`);
  }
}

document.getElementById("save-as").addEventListener("click", doSaveAs);
document.getElementById("save-quick").addEventListener("click", doSaveQuick);
document.getElementById("copy").addEventListener("click", doCopy);
document.getElementById("pin").addEventListener("click", () => {
  api.pin(composeForExport()).catch(() => {});
});

// ── Zoom ───────────────────────────────────────────────────────────────────

function applyZoom() {
  els.canvasWrap.style.transform = `scale(${state.zoom})`;
  els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitToWindow() {
  const rect = els.viewport.getBoundingClientRect();
  const pad = 32;
  const availW = rect.width - pad;
  const availH = rect.height - pad;
  if (state.baseW <= 0 || state.baseH <= 0) return;
  const scale = Math.min(availW / state.baseW, availH / state.baseH, 1);
  state.zoom = Math.max(0.1, scale);
  applyZoom();
}

document.getElementById("zoom-in").addEventListener("click", () => {
  state.zoom = Math.min(4, state.zoom * 1.2);
  applyZoom();
});
document.getElementById("zoom-out").addEventListener("click", () => {
  state.zoom = Math.max(0.1, state.zoom / 1.2);
  applyZoom();
});
document.getElementById("zoom-fit").addEventListener("click", fitToWindow);

window.addEventListener("resize", () => {
  // Keep the composition visible on window resize, but don't re-fit while user
  // is mid-draw.
  if (!pointerActive) fitToWindow();
});

// ── Keyboard shortcuts ─────────────────────────────────────────────────────

const TOOL_KEYS = {
  v: "select", c: "crop", r: "rect", o: "ellipse", l: "line",
  a: "arrow", t: "text", h: "rect-fill", n: "counter", p: "pen", b: "blur"
};

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (mod && e.key.toLowerCase() === "z" && e.shiftKey)  { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === "s")                { e.preventDefault(); doSaveAs(); return; }
  if (mod && e.key.toLowerCase() === "c" && !els.textInput.matches(":focus")) {
    e.preventDefault(); doCopy(); return;
  }
  if (e.key === "Escape")                                 { api.close(); return; }

  if (!els.textInput.matches(":focus")) {
    const t = TOOL_KEYS[e.key.toLowerCase()];
    if (t) setTool(t);
  }
});

// ── Toast ──────────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2200);
}
