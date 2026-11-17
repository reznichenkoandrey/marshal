// desktop/renderer/assistant-neural.js
//
// Hero visual of the Neural look (#439): a band of filmed smoke flowing out of
// a violet orb. The smoke is a looped video strip (white on black) with three
// bands stacked vertically: calm filaments, extra filaments that come in with
// speech, and soft translucent tongues. It is tinted on the canvas, so every
// colour comes from the look's tokens: --accent for the smoke, --accent-2 for
// the orb, the state colour while waiting or offline.
//
// createHudVisual owns the frame loop and visibility (#281); this module only
// draws a frame and plays or pauses its video. The top half is pure and
// covered by tests/assistant-visual.test.ts.

const TAU = Math.PI * 2;
const VIDEO_BANDS = 3;
// Cutout around the orb, as a multiple of its radius; smoke curls inside the gap.
const RING = 1.32;

/**
 * Per-state parameters. `smoke` is how much of the extra filament band shows,
 * `talk` how much the voice envelope pushes the orb and the tongues, `tint`
 * which colour the smoke takes.
 */
export const NEURAL_STATES = {
  idle: { amp: 0.5, speed: 0.5, orb: 0.25, smoke: 0, talk: 0, tint: "accent" },
  listening: { amp: 0.85, speed: 1.5, orb: 0.6, smoke: 0.45, talk: 0.3, tint: "accent" },
  thinking: { amp: 0.7, speed: 0.7, orb: 1.8, smoke: 0.25, talk: 0, tint: "accent" },
  speaking: { amp: 0.8, speed: 1.8, orb: 1.4, smoke: 1, talk: 1, tint: "accent" },
  working: { amp: 0.65, speed: 1, orb: 1.2, smoke: 0.3, talk: 0, tint: "accent" },
  waiting: { amp: 0.5, speed: 0.6, orb: 0.35, smoke: 0, talk: 0, tint: "state" },
  offline: { amp: 0.3, speed: 0.2, orb: 0.1, smoke: 0, talk: 0, tint: "state" },
  sleeping: { amp: 0.3, speed: 0.2, orb: 0.1, smoke: 0, talk: 0, tint: "accent" }
};

export function neuralTarget(state) {
  return NEURAL_STATES[state] ?? NEURAL_STATES.idle;
}

function hash3(i, j, k) {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const a0 = hash3(xi, yi, zi), a1 = hash3(xi + 1, yi, zi), a2 = hash3(xi, yi + 1, zi), a3 = hash3(xi + 1, yi + 1, zi);
  const b0 = hash3(xi, yi, zi + 1), b1 = hash3(xi + 1, yi, zi + 1), b2 = hash3(xi, yi + 1, zi + 1), b3 = hash3(xi + 1, yi + 1, zi + 1);
  const a = a0 + (a1 - a0) * u + (a2 + (a3 - a2) * u - (a0 + (a1 - a0) * u)) * v;
  const b = b0 + (b1 - b0) * u + (b2 + (b3 - b2) * u - (b0 + (b1 - b0) * u)) * v;
  return a + (b - a) * w;
}

const lerp = (a, b, k) => a + (b - a) * k;
const smoothstep = (e0, e1, x) => {
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return k * k * (3 - 2 * k);
};

/** Syllable-like bursts with pauses between phrases, 0..1: drives speech when there is no real level. */
export function voiceEnvelope(t) {
  const syllable = Math.max(0, Math.sin(t * 7.3)) * (0.55 + 0.45 * noise3(t * 1.7, 3, 1));
  return syllable * smoothstep(0.3, 0.5, noise3(t * 0.6, 7, 2));
}

const mix = (from, to, k) => from.map((c, i) => c + (to[i] - c) * k);
const scale = (rgb, k) => rgb.map((c) => c * k);
const css = (rgb, alpha = 1) => `rgba(${rgb.map((c) => Math.round(c)).join(",")},${alpha})`;
const WHITE = [255, 255, 255];
const GREY = [128, 128, 128];
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Field lines on the orb surface; reach sets how far each one twists on its way down.
const FIELD_LINES = Array.from({ length: 7 }, (_, i) => ({
  azimuth: (i / 11) * TAU + hash3(i, 5, 3) * 0.9,
  reach: (hash3(i, 6, 3) - 0.3) * 1.6,
  from: 0.1 + 0.5 * hash3(i, 7, 3),
  to: Math.PI - 0.1 - 1.2 * hash3(i, 8, 3)
}));

/**
 * `onReady` is called once the first video frame is decoded, so a static
 * (reduced motion) frame can be redrawn with smoke in it.
 */
export function createNeuralRenderer({ onReady } = {}) {
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("muted", "");
  video.src = new URL("./media/neural-smoke.mp4", import.meta.url).href;
  video.addEventListener("loadeddata", () => onReady?.(), { once: true });

  const cur = { ...NEURAL_STATES.idle, color: null };
  let clock = 0;
  let rot = 0;
  let key = "";
  let W = 0, H = 0, R = 0, cx = 0, cy = 0, dpr = 1, bandHalf = 0;
  let frame = null, bandPath = null, orbSprite = null, edgeMask = null;
  let smoke = null, sctx = null, glow = null, gctx = null;
  let palette = null;

  const ready = () => video.readyState >= 2 && video.videoWidth > 0;

  function build(canvas, width, height, colors) {
    dpr = Math.max(1, width / Math.max(1, canvas.clientWidth));
    W = width / dpr;
    H = height / dpr;
    cx = W / 2;
    cy = H / 2;
    R = Math.min(H * 0.34, W * 0.14, 84);
    bandHalf = Math.min(H * 0.27, R * 0.55);

    const light = luma(colors.surface) > 128;
    palette = {
      band: scale(light ? colors.fg : colors.surface, light ? 0.55 : 0.32),
      orb: colors.second,
      rim: mix(colors.second, WHITE, 0.6),
      pale: mix(colors.second, WHITE, 0.7),
      vein: mix(colors.second, WHITE, 0.75),
      back: mix(colors.accent, WHITE, 0.7),
      spark: mix(colors.accent, WHITE, 0.9)
    };

    frame = document.createElement("canvas");
    frame.width = width;
    frame.height = height;
    const f = frame.getContext("2d");
    f.setTransform(dpr, 0, 0, dpr, 0, 0);
    const Rn = R * RING;
    const dx = Math.sqrt(Math.max(0, Rn * Rn - bandHalf * bandHalf));
    const top = cy - bandHalf, bot = cy + bandHalf;
    const band = new Path2D();
    band.moveTo(0, top);
    band.lineTo(cx - dx, top);
    band.arc(cx, cy, Rn, Math.atan2(-bandHalf, -dx), Math.atan2(-bandHalf, dx), false);
    band.lineTo(W, top);
    band.lineTo(W, bot);
    band.lineTo(cx + dx, bot);
    band.arc(cx, cy, Rn, Math.atan2(bandHalf, dx), Math.atan2(bandHalf, -dx), false);
    band.lineTo(0, bot);
    band.closePath();
    bandPath = band;
    f.fillStyle = css(palette.band);
    f.fill(band);
    const edge = f.createLinearGradient(0, 0, W, 0);
    edge.addColorStop(0, css(colors.accent, 0.12));
    edge.addColorStop(cx / W, css(colors.accent, 0.65));
    edge.addColorStop(1, css(colors.accent, 0.12));
    f.strokeStyle = edge;
    f.lineWidth = 1.3;
    f.stroke(band);

    // Orb sprite: matte body in --accent-2 with a fine dot matrix, drawn once per size.
    const size = Math.ceil(R * 2 + 4);
    orbSprite = document.createElement("canvas");
    orbSprite.width = Math.round(size * dpr);
    orbSprite.height = Math.round(size * dpr);
    const o = orbSprite.getContext("2d");
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.translate(size / 2, size / 2);
    const muted = mix(palette.orb, GREY, 0.4);
    const body = o.createRadialGradient(-R * 0.25, -R * 0.3, R * 0.05, 0, 0, R);
    body.addColorStop(0, css(scale(muted, 0.86)));
    body.addColorStop(0.7, css(scale(muted, 0.67)));
    body.addColorStop(0.93, css(scale(muted, 0.83)));
    body.addColorStop(1, css(palette.pale));
    o.fillStyle = body;
    o.beginPath();
    o.arc(0, 0, R, 0, TAU);
    o.fill();
    o.save();
    o.clip();
    o.fillStyle = css(palette.vein, 0.05);
    for (let y = -R; y <= R; y += 2.6) for (let x = -R; x <= R; x += 2.6) o.fillRect(x, y, 1, 1);
    o.strokeStyle = css(palette.vein, 0.18);
    o.lineWidth = 0.7;
    for (let i = 0; i < 46; i++) {
      let x = (hash3(i, 1, 21) - 0.5) * 2 * R, y = (hash3(i, 2, 21) - 0.5) * 2 * R, a = hash3(i, 3, 21) * 6.3;
      o.beginPath();
      o.moveTo(x, y);
      for (let k = 0; k < 14; k++) {
        a += (noise3(x / 18, y / 18, i) - 0.5) * 1.6;
        x += Math.cos(a) * 3;
        y += Math.sin(a) * 3;
        o.lineTo(x, y);
      }
      o.stroke();
    }
    o.restore();
    const rim = o.createLinearGradient(-R, 0, R, 0);
    rim.addColorStop(0, css(palette.rim, 0.55));
    rim.addColorStop(0.5, css(palette.rim, 0.25));
    rim.addColorStop(1, css(palette.rim, 0.55));
    o.strokeStyle = rim;
    o.lineWidth = 1.4;
    o.beginPath();
    o.arc(0, 0, R - 0.5, 0, TAU);
    o.stroke();

    // The smoke fades out at both ends of the band.
    edgeMask = f.createLinearGradient(0, 0, W, 0);
    edgeMask.addColorStop(0, "rgba(0,0,0,0)");
    edgeMask.addColorStop(0.07, "rgba(0,0,0,1)");
    edgeMask.addColorStop(0.93, "rgba(0,0,0,1)");
    edgeMask.addColorStop(1, "rgba(0,0,0,0)");

    smoke = document.createElement("canvas");
    smoke.width = width;
    smoke.height = height;
    sctx = smoke.getContext("2d");
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    glow = document.createElement("canvas");
    glow.width = Math.max(1, Math.round(W / 2));
    glow.height = Math.max(1, Math.round(H / 2));
    gctx = glow.getContext("2d");
  }

  function drawSmoke(v, push) {
    const h = bandHalf * 2 * (0.65 + 0.35 * cur.amp + 0.3 * push);
    const y = cy - h / 2;
    const vw = video.videoWidth, vh = video.videoHeight / VIDEO_BANDS;
    const extra = cur.smoke * lerp(1, 0.3 + 0.7 * v, cur.talk);
    const layers = (filter) => {
      sctx.filter = filter;
      sctx.globalAlpha = 0.85;
      sctx.drawImage(video, 0, 0, vw, vh, 0, y, W, h);
      if (extra > 0.01) {
        sctx.globalAlpha = Math.min(1, extra);
        sctx.drawImage(video, 0, vh, vw, vh, 0, y, W, h);
      }
      sctx.globalAlpha = 1;
      sctx.filter = "none";
    };
    sctx.globalCompositeOperation = "source-over";
    sctx.fillStyle = "#000";
    sctx.fillRect(0, 0, W, H);
    sctx.globalCompositeOperation = "lighter";
    // Soft translucent tongues: a taller copy behind the filaments, swelling with the voice.
    const tongueH = h * (1.5 + 0.4 * push);
    sctx.globalAlpha = Math.min(1, 0.55 + 0.2 * cur.smoke + 0.3 * push);
    sctx.filter = "brightness(1.35)";
    sctx.drawImage(video, 0, vh * 2, vw, vh, 0, cy - tongueH / 2, W, tongueH);
    sctx.filter = "none";
    sctx.globalAlpha = 1;
    layers("contrast(1.5) brightness(1.1)");
    // Ring: thin columns of the strip bent around the orb, so smoke curls inside the cutout.
    const rm = (R * (1 + RING)) / 2, th = R * (RING - 1) * 1.6, n = 72, seg = (TAU * rm) / n;
    const sw = (vw * 0.5) / n;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + clock * 0.15;
      sctx.globalAlpha = Math.min(1, (0.08 + 0.55 * Math.cos(a) ** 4) * (1 + 1.2 * push));
      sctx.save();
      sctx.translate(cx + Math.cos(a) * rm, cy + Math.sin(a) * rm);
      sctx.rotate(a + Math.PI / 2);
      sctx.drawImage(video, vw * 0.5 + k * sw, 0, sw, vh, -seg / 2, -th / 2, seg + 1, th);
      sctx.restore();
    }
    sctx.globalAlpha = 1;
    // Tint the white smoke to the smoke colour, brightest where it meets the orb.
    const near = Math.min(0.45, (R * 1.8) / W);
    const at = cx / W;
    const g = sctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, css(scale(cur.color, 0.6)));
    g.addColorStop(Math.max(0, at - near), css(scale(cur.color, 0.95)));
    g.addColorStop(at, css(mix(cur.color, [236, 230, 204], 0.3)));
    g.addColorStop(Math.min(1, at + near), css(scale(cur.color, 0.95)));
    g.addColorStop(1, css(scale(cur.color, 0.6)));
    sctx.globalCompositeOperation = "multiply";
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, W, H);
    // Only the densest cores go back toward white.
    sctx.globalCompositeOperation = "lighter";
    layers("contrast(4) brightness(0.22)");

    sctx.globalCompositeOperation = "destination-in";
    sctx.fillStyle = edgeMask;
    sctx.fillRect(0, 0, W, H);
    sctx.globalCompositeOperation = "source-over";
    // Bloom: one blur on a half-resolution copy, not shadowBlur per stroke.
    gctx.clearRect(0, 0, glow.width, glow.height);
    gctx.drawImage(smoke, 0, 0, glow.width, glow.height);
  }

  function drawOrb(ctx, t, v) {
    ctx.save();
    ctx.translate(cx, cy);
    const halo = ctx.createRadialGradient(0, 0, R * 0.95, 0, 0, R * 1.3);
    halo.addColorStop(0, css(cur.color, 0.07));
    halo.addColorStop(1, css(cur.color, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.3, 0, TAU);
    ctx.fill();
    const pink = ctx.createRadialGradient(0, 0, R * 0.96, 0, 0, R * 1.07);
    pink.addColorStop(0, css(palette.pale, 0.35));
    pink.addColorStop(1, css(palette.pale, 0));
    ctx.fillStyle = pink;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.07, 0, TAU);
    ctx.fill();
    // Speech sways and pulses the orb; the sway stays inside the ring cutout.
    ctx.translate(
      cur.talk * R * 0.09 * (noise3(t * 2.2, 1, 5) - 0.5) * 2,
      cur.talk * R * (0.05 * (noise3(t * 1.9, 2, 5) - 0.5) * 2 - 0.06 * v)
    );
    const pulse = 1 + cur.talk * (0.02 + 0.1 * v);
    ctx.scale(pulse, pulse);
    const size = orbSprite.width / dpr;
    ctx.drawImage(orbSprite, -size / 2, -size / 2, size, size);

    // Curly streamers on the sphere surface: the smoke goes on inside the orb.
    const tilt = 0.35, ct = Math.cos(tilt), st = Math.sin(tilt);
    const march = (t * (0.5 + cur.orb * 0.7)) % 1;
    const back = new Path2D(), front = new Path2D(), dots = new Path2D();
    FIELD_LINES.forEach((line, i) => {
      const steps = Math.round((line.to - line.from) * 24);
      let open = false, prevFront = false;
      for (let k = 0; k <= steps; k++) {
        const th = line.from + (line.to - line.from) * (k / steps);
        const ph = line.azimuth + rot + line.reach * 2.2 * (th / Math.PI) ** 2
          + 0.3 * Math.sin(th * 4 + t * 1.1 + i) + 0.08 * Math.sin(th * 11 - t * 2 + i * 2);
        const rr = 0.96 * Math.sin(th);
        const x = rr * Math.cos(ph) * R, z0 = rr * Math.sin(ph), ly = -0.96 * Math.cos(th);
        const y = (ly * ct - z0 * st) * R, z = ly * st + z0 * ct;
        const isFront = z > 0;
        const path = isFront ? front : back;
        if (!open || isFront !== prevFront) path.moveTo(x, y);
        else path.lineTo(x, y);
        open = true;
        prevFront = isFront;
        if (isFront && (k + Math.floor(march * 3)) % 3 === 0 && i % 2) dots.rect(x - 0.7, y - 0.7, 1.4, 1.4);
      }
    });
    const hot = mix(cur.color, WHITE, 0.6);
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = css(palette.back, 0.16);
    ctx.stroke(back);
    ctx.lineWidth = 1;
    ctx.strokeStyle = css(hot, 0.5);
    ctx.stroke(front);
    ctx.fillStyle = css(palette.spark, 0.8);
    ctx.fill(dots);

    // Bright crescents just outside the rim, where incoming strands pile up.
    const cres = new Path2D();
    for (let j = 0; j < 9; j++) {
      const side = j % 2 ? 0 : Math.PI;
      const rr = R * (1.02 + 0.015 * j);
      const span = 0.45 + 0.5 * noise3(j * 0.9, 2.2, clock * 0.8);
      const shift = (noise3(j * 1.7, 5.1, clock * 0.6) - 0.5) * 0.6;
      cres.moveTo(Math.cos(side + shift - span) * rr, Math.sin(side + shift - span) * rr);
      cres.arc(0, 0, rr, side + shift - span, side + shift + span);
    }
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = css(hot, 0.35);
    ctx.stroke(cres);
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }

  return {
    /**
     * `level` is the live mic level (0..1) or null; `colors` are rgb arrays of
     * the tokens createHudVisual resolves. `dt` 0 snaps to the state (static frame).
     */
    draw(ctx, width, height, t, dt, { state, level, colors }) {
      const target = neuralTarget(state);
      const smokeColor = target.tint === "state" ? colors.state : colors.accent;
      const nextKey = [width, height, ctx.canvas.clientWidth, colors.surface, colors.second, colors.accent, colors.fg].join("|");
      if (nextKey !== key) {
        key = nextKey;
        build(ctx.canvas, width, height, colors);
      }
      const k = dt === 0 ? 1 : Math.min(1, dt * 3);
      for (const name of ["amp", "speed", "orb", "smoke", "talk"]) cur[name] = lerp(cur[name], target[name], k);
      cur.color = cur.color ? mix(cur.color, smokeColor, k) : [...smokeColor];
      clock += dt * cur.speed;
      rot += dt * (0.12 + 0.35 * cur.orb);
      const rate = Math.min(2, Math.max(0.5, 0.4 + cur.speed * 0.7));
      if (Math.abs(video.playbackRate - rate) > 0.05) video.playbackRate = rate;
      const v = state === "listening" && level != null ? level : voiceEnvelope(t);
      const push = cur.talk * v;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(frame, 0, 0, W, H);
      const withSmoke = ready();
      if (withSmoke) {
        drawSmoke(v, push);
        ctx.save();
        ctx.clip(bandPath);
        ctx.globalCompositeOperation = "lighter";
        ctx.filter = "blur(5px)";
        ctx.drawImage(glow, 0, 0, W, H);
        ctx.filter = "none";
        ctx.drawImage(smoke, 0, 0, W, H);
        ctx.restore();
      }
      drawOrb(ctx, t, v);
      if (withSmoke) {
        // Strands that pass in front of the sphere.
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.98, 0, TAU);
        ctx.clip();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.22;
        ctx.drawImage(smoke, 0, 0, W, H);
        ctx.restore();
      }
      ctx.restore();
    },
    play() {
      if (video.paused) video.play().catch(() => undefined);
    },
    pause() {
      if (!video.paused) video.pause();
    }
  };
}

