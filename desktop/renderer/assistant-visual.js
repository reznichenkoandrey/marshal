// desktop/renderer/assistant-visual.js
//
// Voice visual of the assistant home: a dotted particle wave whose height
// follows the voice level, over a soft glow in the state colour (#398). The
// mini widget (#285) keeps the round HUD: a wave is unreadable at its size.
//
// The top half is pure (state styles, parameter interpolation, colour mixing,
// the fallback level) and covered by tests/assistant-visual.test.ts. The
// bottom half draws on a canvas and owns the frame loop, which runs only
// while the window is visible (#281).

const TAU = Math.PI * 2;

export const STATES = ["idle", "listening", "thinking", "speaking", "working", "waiting", "offline", "sleeping"];

/**
 * Per-state look. `color` is a design token; `spin` scales ring rotation,
 * `glow` the core brightness, `energy` how much of the level reaches the bars, `scan`
 * the radar sweep used while thinking.
 */
export const STATE_STYLE = {
  idle: { color: "--state-idle", spin: 0.6, glow: 0.5, energy: 0.6, scan: 0 },
  listening: { color: "--state-listen", spin: 1, glow: 1, energy: 1, scan: 0 },
  thinking: { color: "--state-think", spin: 3, glow: 0.9, energy: 0.5, scan: 1 },
  speaking: { color: "--state-speak", spin: 1.2, glow: 1, energy: 1, scan: 0 },
  working: { color: "--state-think", spin: 1.6, glow: 0.7, energy: 0.6, scan: 0 },
  waiting: { color: "--state-wait", spin: 0.8, glow: 0.9, energy: 0.7, scan: 0 },
  offline: { color: "--state-fail", spin: 0.2, glow: 0.3, energy: 0.3, scan: 0 },
  sleeping: { color: "--state-idle", spin: 0.1, glow: 0.2, energy: 0.2, scan: 0 }
};

export const STATE_LABELS = {
  uk: {
    idle: "Готовий",
    listening: "Слухаю",
    thinking: "Думаю",
    speaking: "Говорю",
    working: "Працюю",
    waiting: "Чекає на тебе",
    offline: "Офлайн",
    sleeping: "Сплю"
  },
  en: {
    idle: "Ready",
    listening: "Listening",
    thinking: "Thinking",
    speaking: "Speaking",
    working: "Working",
    waiting: "Needs you",
    offline: "Offline",
    sleeping: "Asleep"
  }
};

export function normalizeState(state) {
  return STATES.includes(state) ? state : "idle";
}

export function stateLabel(state, lang) {
  return (STATE_LABELS[lang] ?? STATE_LABELS.en)[normalizeState(state)];
}

/** Numeric parameters the frame loop eases between: no hard cut on a state change. */
export function targetParams(state) {
  const { spin, glow, energy, scan } = STATE_STYLE[normalizeState(state)];
  return { spin, glow, energy, scan };
}

/**
 * Exponential approach, frame-rate independent: after `dt` seconds the gap
 * shrinks by e^(-dt/tau). tau 0.25 s settles a state change in under a second.
 */
export function stepParams(current, target, dt, tau = 0.25) {
  const k = 1 - Math.exp(-Math.max(0, dt) / tau);
  const next = {};
  for (const key of Object.keys(target)) {
    const from = current[key] ?? target[key];
    next[key] = from + (target[key] - from) * k;
  }
  return next;
}

/**
 * Computed colour → [r, g, b] in 0..255; anything else → null. Chromium
 * serialises plain colours as "rgb(…)" but color-mix() results — most of our
 * tokens — as "color(srgb 0.3 0.76 1 / 0.3)".
 */
export function parseRgb(value) {
  const text = String(value ?? "");
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(text);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const srgb = /color\(\s*srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)/.exec(text);
  if (srgb) return [srgb[1], srgb[2], srgb[3]].map((channel) => Math.min(255, Math.max(0, Number(channel) * 255)));
  return null;
}

export function mixRgb(from, to, t) {
  const k = Math.min(1, Math.max(0, t));
  return from.map((channel, i) => channel + (to[i] - channel) * k);
}

export function rgba(rgb, alpha = 1) {
  const [r, g, b] = rgb.map((channel) => Math.round(channel));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Level used when there is no microphone signal: a slow breath when idle,
 * syllable bursts while speaking, a low hum while thinking. `noise` is a
 * 0..1 value the caller supplies so tests stay deterministic.
 */
export function ambientLevel(state, t, noise = 0.5) {
  switch (normalizeState(state)) {
    case "listening":
      return 0.3 + 0.35 * Math.abs(Math.sin(t * 3.1) * Math.sin(t * 7.3 + 1)) + 0.12 * noise;
    case "speaking":
      return 0.25 + 0.55 * Math.max(0, Math.sin(t * 9)) * (0.6 + 0.4 * Math.sin(t * 1.3));
    case "thinking":
      return 0.12 + 0.06 * Math.sin(t * 4);
    case "working":
      return 0.14 + 0.08 * Math.abs(Math.sin(t * 2.2));
    case "waiting":
      return 0.18 + 0.14 * Math.max(0, Math.sin(t * 2.4));
    case "offline":
    case "sleeping":
      return 0.02;
    default:
      return 0.06 + 0.03 * Math.sin(t * 1.2);
  }
}

/**
 * Frame budget: 30 fps on power, 20 on battery. The HUD moves slowly; the
 * display rate (60–120 Hz) only doubled the cost without a visible gain.
 */
export function frameIntervalMs(onBattery) {
  return 1000 / (onBattery ? 20 : 30);
}

// ── Drawing ──────────────────────────────────────────────────────────────
//
// No shadowBlur anywhere: per-path blur on a 60 fps canvas filled Chromium's
// GPU cache to ~320 MB and kept the GPU process at ~57% CPU (#281). Strokes
// are batched per colour, and the outer scale is drawn once into a sprite.

const BAR_COUNT = 72;
const scaleSprites = new WeakMap();

/** The 120-tick outer scale never changes shape, only angle: draw it once. */
function scaleSprite(ctx, w, R, edge) {
  const cached = scaleSprites.get(ctx);
  if (cached && cached.w === w && cached.edge === edge) return cached.canvas;
  const canvas = new OffscreenCanvas(w, w);
  const sprite = canvas.getContext("2d");
  const c = w / 2;
  sprite.strokeStyle = edge;
  sprite.lineWidth = 1;
  for (const long of [false, true]) {
    sprite.globalAlpha = long ? 0.9 : 0.5;
    sprite.beginPath();
    for (let i = 0; i < 120; i++) {
      if ((i % 10 === 0) !== long) continue;
      const a = (i / 120) * TAU;
      const r0 = R * 1.72;
      const r1 = r0 + (long ? R * 0.09 : R * 0.04);
      sprite.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
      sprite.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    }
    sprite.stroke();
  }
  scaleSprites.set(ctx, { w, edge, canvas });
  return canvas;
}

/**
 * One frame. `colors` holds resolved rgb triples: state, edge, second (the
 * accent-2 arcs), fg, muted. `params` are the eased numbers above.
 */
export function drawHud(ctx, size, t, level, params, colors, bars, labels, mini = false) {
  const w = size;
  const cx = w / 2;
  const cy = w / 2;
  const R = w * 0.26;
  const spin = params.spin;
  const state = rgba(colors.state);
  const edge = rgba(colors.edge, 0.55);
  const second = rgba(colors.second);

  ctx.clearRect(0, 0, w, w);

  const ray = (path, a, r0, r1) => {
    path.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    path.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
  };
  const segment = (path, r, a0, a1) => {
    path.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
    path.arc(cx, cy, r, a0, a1);
  };
  const stroke = (path, color, lineWidth, alpha = 1) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke(path);
    ctx.globalAlpha = 1;
  };

  // Outer scale: fine ticks, slowly counter-rotating. The mini widget (#285)
  // drops it, the inner scale, the blips and the readout: unreadable at its size.
  if (!mini) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-t * 0.05);
    ctx.drawImage(scaleSprite(ctx, w, R, edge), -cx, -cy);
    ctx.restore();
  }

  // Spectrum: 300° of radial bars, a gap at the bottom for the readout.
  const start = Math.PI / 2 + Math.PI / 6;
  const span = TAU - Math.PI / 3;
  const lv = level * params.energy;
  const barsMain = new Path2D();
  const barsTail = new Path2D();
  for (let i = 0; i < BAR_COUNT; i++) {
    const shape = Math.abs(Math.sin(i * 0.61 + t * 5) * Math.sin(i * 0.23 - t * 3.1));
    const target = lv * (0.45 + 0.55 * shape);
    bars[i] = (bars[i] ?? 0) + (target - (bars[i] ?? 0)) * 0.25;
    const r0 = R * 1.3;
    ray(i > BAR_COUNT * 0.82 ? barsTail : barsMain, start + (i / (BAR_COUNT - 1)) * span, r0, r0 + R * (0.05 + 0.32 * bars[i]));
  }
  stroke(barsMain, state, 3);
  stroke(barsTail, second, 3);

  // Segmented rings rotating against each other, with their guide circles.
  const guides = new Path2D();
  segment(guides, R * 1.12, 0, TAU);
  segment(guides, R * 0.72, 0, TAU);
  stroke(guides, edge, 1);
  const outer = new Path2D();
  for (let i = 0; i < 4; i++) {
    const a = t * 0.6 * spin + (i * TAU) / 4;
    segment(outer, R * 1.12, a, a + 0.9);
  }
  stroke(outer, state, 6, 0.85);
  const inner = new Path2D();
  for (let i = 0; i < 12; i++) {
    const a = -t * 0.9 * spin + (i * TAU) / 12;
    segment(inner, R * 0.9, a, a + 0.22);
  }
  stroke(inner, second, 3, 0.9);

  // Inner scale: lit ticks follow the level, a VU meter bent into a circle.
  if (!mini) {
    const lit = new Path2D();
    const dark = new Path2D();
    for (let i = 0; i < 48; i++) {
      ray(i / 48 < lv ? lit : dark, -Math.PI / 2 + (i / 48) * TAU, R * 0.6, R * 0.66);
    }
    stroke(dark, edge, 2);
    stroke(lit, second, 2);
  }

  const meter = new Path2D();
  segment(meter, R * 0.72, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, lv));
  stroke(meter, state, 4);

  // Orbiting blips.
  for (let i = 0; i < (mini ? 0 : 3); i++) {
    const a = t * (0.4 + i * 0.25) * spin + i * 2.1;
    ctx.fillStyle = i === 1 ? second : state;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * R * 1.5, cy + Math.sin(a) * R * 1.5, w * 0.008, 0, TAU);
    ctx.fill();
  }

  // Core.
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.6);
  core.addColorStop(0, rgba(colors.state, 1));
  core.addColorStop(Math.min(0.95, 0.25 + lv * 0.3), rgba(colors.state, 0.25));
  core.addColorStop(1, rgba(colors.state, 0));
  ctx.globalAlpha = 0.35 + lv * 0.6 * params.glow;
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.6, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;

  if (params.scan > 0.01) {
    const sweep = new Path2D();
    ray(sweep, t * 4, 0, R * 1.12);
    stroke(sweep, state, 2, 0.6 * params.scan);
  }

  if (mini) return;
  ctx.textAlign = "center";
  ctx.fillStyle = rgba(colors.fg);
  ctx.font = `600 ${Math.round(w * 0.05)}px ui-monospace, Menlo, monospace`;
  ctx.fillText(`${Math.round(Math.min(1, level) * 100)}`.padStart(2, "0"), cx, cy + w * 0.012);
  ctx.fillStyle = state;
  ctx.font = `500 ${Math.round(w * 0.024)}px ui-monospace, Menlo, monospace`;
  ctx.fillText(labels.state.toUpperCase(), cx, cy + w * 0.055);
  ctx.fillStyle = rgba(colors.muted);
  ctx.fillText(labels.footer, cx, cy + R * 1.62);
}

const WAVE_COLS = 96;
const WAVE_ROWS = 22;
// Brightness buckets: dots are batched into one path per bucket, so a frame
// is WAVE_BUCKETS fills however many dots there are.
const WAVE_BUCKETS = 4;

/**
 * One frame of the home wave on a `w`×`h` canvas. Rows run from the back
 * (small, faint) to the front; a dot's height is a sum of two travelling
 * sines under an envelope that flattens both ends. The crest takes the state
 * colour, the rest the muted text colour. `params.scan` sweeps a lit band
 * across while thinking.
 */
export function drawWave(ctx, w, h, t, level, params, colors) {
  const spin = params.spin;
  const lv = level * params.energy;
  const unit = Math.min(w, h);
  ctx.clearRect(0, 0, w, h);

  // Glow under the crest: the "core" of the visual, in the state colour.
  const cx = w / 2;
  const cy = h * 0.52;
  // Radius inside the canvas: a glow cut by the canvas edge shows a hard box.
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, unit * 0.48);
  glow.addColorStop(0, rgba(colors.state, 0.32 + 0.4 * lv * params.glow));
  glow.addColorStop(0.45, rgba(colors.state, 0.1 + 0.12 * lv));
  glow.addColorStop(1, rgba(colors.state, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const crest = new Array(WAVE_BUCKETS).fill(null).map(() => new Path2D());
  const rest = new Array(WAVE_BUCKETS).fill(null).map(() => new Path2D());
  const amp = h * (0.1 + 0.26 * lv);
  const sweep = ((t * 0.35) % 1.4) - 0.2;
  for (let j = 0; j < WAVE_ROWS; j++) {
    const z = j / (WAVE_ROWS - 1);
    const spread = w * (0.56 + 0.36 * z);
    const base = h * (0.28 + 0.5 * z);
    const dot = Math.max(1, unit * (0.0035 + 0.004 * z));
    const depth = Math.min(WAVE_BUCKETS - 1, Math.floor(z * WAVE_BUCKETS));
    for (let i = 0; i < WAVE_COLS; i++) {
      const x = i / (WAVE_COLS - 1);
      const envelope = Math.sin(Math.PI * x) ** 1.6;
      const wave =
        0.65 * Math.sin(x * 5.2 + z * 2.4 - t * 0.7 * spin) +
        0.35 * Math.sin(x * 11.5 - z * 4.1 + t * 1.6 * (0.4 + lv));
      const lift = envelope * wave;
      const px = cx + (x - 0.5) * spread;
      const py = base - lift * amp * (0.6 + 0.4 * z);
      const scanned = params.scan > 0.01 && Math.abs(x - sweep) < 0.05;
      const target = lift > 0.32 || scanned ? crest : rest;
      target[depth].rect(px - dot / 2, py - dot / 2, dot, dot);
    }
  }
  for (let b = 0; b < WAVE_BUCKETS; b++) {
    const alpha = 0.3 + (0.7 * (b + 1)) / WAVE_BUCKETS;
    ctx.fillStyle = rgba(colors.muted, alpha * 0.75);
    ctx.fill(rest[b]);
    ctx.fillStyle = rgba(colors.state, alpha);
    ctx.fill(crest[b]);
  }
}

/**
 * Owns the canvas and the frame loop. `getLevel()` returns the live mic level
 * (0..1) or null when there is none; the ambient level fills in.
 */
export function createHudVisual(canvas, { resolveColor, getLevel, labelFor, footer, mini = false }) {
  const ctx = canvas.getContext("2d");
  const bars = new Array(BAR_COUNT).fill(0);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let state = "idle";
  let params = targetParams(state);
  let colors = null;
  let fromColor = null;
  let colorMix = 1;
  let smooth = 0;
  let raf = 0;
  let last = 0;
  let lastDrawn = 0;
  let onBattery = false;
  // Held by the owner (the mini widget's idle pause): no visibility change restarts it.
  let paused = false;

  if (typeof navigator.getBattery === "function") {
    navigator.getBattery().then((battery) => {
      const update = () => { onBattery = !battery.charging; };
      update();
      battery.addEventListener("chargingchange", update);
    }).catch(() => undefined);
  }

  function readColors() {
    return {
      state: resolveColor(STATE_STYLE[state].color),
      edge: resolveColor("--border-strong"),
      second: resolveColor("--accent-2"),
      fg: resolveColor("--text-strong"),
      muted: resolveColor("--text-muted")
    };
  }

  // The mini HUD is square; the home wave fills whatever box CSS gives it.
  function size() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(Math.max(1, canvas.clientWidth) * dpr);
    const height = mini ? width : Math.round(Math.max(1, canvas.clientHeight) * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return [width, height];
  }

  function render(now) {
    const t = now / 1000;
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    params = stepParams(params, targetParams(state), dt);
    colorMix = Math.min(1, colorMix + dt / 0.4);
    const live = getLevel();
    const raw = live ?? ambientLevel(state, t, Math.random());
    smooth += (raw - smooth) * Math.min(1, dt * 10 || 1);
    const current = colors ?? readColors();
    const drawn = fromColor ? { ...current, state: mixRgb(fromColor, current.state, colorMix) } : current;
    const [width, height] = size();
    if (mini) drawHud(ctx, width, t, smooth, params, drawn, bars, { state: labelFor(state), footer }, true);
    else drawWave(ctx, width, height, t, smooth, params, drawn);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    // 2 ms slack: rAF jitter would otherwise turn a 33 ms budget into every third vsync.
    if (now - lastDrawn < frameIntervalMs(onBattery) - 2) return;
    lastDrawn = now;
    render(now);
  }

  function start() {
    if (raf || paused || document.hidden) return;
    if (reducedMotion.matches) {
      params = targetParams(state);
      render(performance.now());
      return;
    }
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  reducedMotion.addEventListener("change", () => {
    stop();
    start();
  });

  return {
    setState(next) {
      const normalized = normalizeState(next);
      if (normalized === state && colors) return;
      fromColor = colors ? (fromColor && colorMix < 1 ? mixRgb(fromColor, colors.state, colorMix) : colors.state) : null;
      state = normalized;
      colors = readColors();
      colorMix = fromColor ? 0 : 1;
      if (reducedMotion.matches) render(performance.now());
    },
    refreshColors() {
      colors = readColors();
      fromColor = null;
      if (reducedMotion.matches) render(performance.now());
    },
    /** Stops the loop on the last drawn frame until released. */
    setPaused(next) {
      paused = next;
      if (paused) stop();
      else start();
    },
    start,
    stop,
    isRunning: () => raf !== 0
  };
}
