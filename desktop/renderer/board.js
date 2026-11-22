// Board window (#276): a spoken or typed request drives one Mermaid diagram.
// Everything that decides something lives in board-ops.js; this file wires it
// to the DOM, to main (model calls) and to Mermaid, which is imported only
// when the first diagram is drawn.

import { applyOps, diagramFromReply, directOps, emptyBoard, parseOps, resolveDiagram } from "./board-ops.js";

const api = window.marshalBoard;
const t = (key, params) => window.MarshalI18n.t(key, params);
const LANGUAGE_KEY = "marshal.board.language";

const request = document.getElementById("request");
const drawButton = document.getElementById("draw-btn");
const languageSelect = document.getElementById("board-language");
const statusLine = document.getElementById("status");
const errorLine = document.getElementById("error");
const diagram = document.getElementById("diagram");
const emptyNote = document.getElementById("empty");
const sourceView = document.getElementById("source");
const revealButton = document.getElementById("reveal-btn");

let board = emptyBoard();
let busy = false;
let renderCount = 0;
let mermaidLoad = null;
let statusKey = "";
// A spoken request that arrived while another one was being drawn; the newest wins.
let queued = null;

function setStatus(key) {
  statusKey = key;
  statusLine.textContent = key ? t(key) : "";
}

function showError(message) {
  errorLine.hidden = !message;
  errorLine.textContent = message ?? "";
}

function setBusy(next) {
  busy = next;
  drawButton.disabled = next;
}

// Mermaid derives its palette with colour maths, so it needs plain hex, not var() or color-mix().
let probeContext = null;
function tokenColor(name) {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  probeContext ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  probeContext.clearRect(0, 0, 1, 1);
  probeContext.fillStyle = getComputedStyle(probe).color;
  probeContext.fillRect(0, 0, 1, 1);
  probe.remove();
  const [red, green, blue] = probeContext.getImageData(0, 0, 1, 1).data;
  return { hex: `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`, light: (red + green + blue) / 3 };
}

function mermaidConfig() {
  const background = tokenColor("--bg-app");
  const surface = tokenColor("--bg-surface").hex;
  const text = tokenColor("--text-default").hex;
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    // The bundled Fixel has Cyrillic; a system stack is not guaranteed to (spec §3.1).
    fontFamily: getComputedStyle(document.body).fontFamily,
    themeVariables: {
      darkMode: background.light < 128,
      background: background.hex,
      primaryColor: tokenColor("--bg-elevated").hex,
      primaryTextColor: text,
      primaryBorderColor: tokenColor("--border-strong").hex,
      secondaryColor: surface,
      tertiaryColor: surface,
      lineColor: tokenColor("--text-muted").hex,
      edgeLabelBackground: background.hex,
      textColor: text,
      noteBkgColor: surface,
      noteTextColor: text
    }
  };
}

async function loadMermaid() {
  mermaidLoad ??= import("./vendor/mermaid/mermaid.esm.min.mjs").then((module) => module.default);
  const mermaid = await mermaidLoad;
  // Per draw, so a theme switched since the last diagram applies to the next one.
  mermaid.initialize(mermaidConfig());
  return mermaid;
}

async function drawDiagram(source) {
  const mermaid = await loadMermaid();
  const result = await resolveDiagram({
    source,
    parse: (candidate) => mermaid.parse(candidate),
    repair: async (broken, error) => {
      setStatus("board.status.repairing");
      const reply = await api.repair({ source: broken, error, language: languageSelect.value });
      return reply.ok ? reply.text : null;
    }
  });
  if (!result.ok) return result.error;
  try {
    const { svg } = await mermaid.render(`board-diagram-${++renderCount}`, result.source);
    // Mermaid's own output under securityLevel "strict"; model text never reaches innerHTML directly.
    diagram.innerHTML = svg;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  board = { ...board, diagram: result.source };
  sourceView.textContent = result.source;
  emptyNote.hidden = true;
  setStatus(result.repaired ? "board.status.repaired" : "board.status.done");
  return null;
}

async function submit() {
  const text = request.value.trim();
  if (busy || text === "") return;
  setBusy(true);
  showError("");
  try {
    let ops = directOps(text);
    const asked = ops.length === 0 ? text : "";
    if (ops.length === 0) {
      setStatus("board.status.thinking");
      const reply = await api.draw({ text, language: languageSelect.value });
      if (!reply.ok) {
        setStatus("");
        showError(reply.error);
        return;
      }
      ops = parseOps(reply.text).ops;
      if (ops.length === 0) ops = [{ op: "setDiagram", mermaid: diagramFromReply(reply.text) }];
    }
    const lastGood = board.diagram;
    board = applyOps(board, ops);
    // A repeated source is still redrawn: that is how a theme switch reaches the diagram.
    if (!ops.some((op) => op.op === "setDiagram")) {
      setStatus("board.status.done");
      return;
    }
    const failure = await drawDiagram(board.diagram);
    if (failure) {
      // Never a broken board: the last good render stays, with one error line.
      board = { ...board, diagram: lastGood };
      setStatus(lastGood ? "board.status.keptLast" : "");
      showError(t("board.error.diagram", { error: failure }));
      return;
    }
    // Every drawn diagram is kept as board.mmd (spec §7); a failed save never hides the board.
    const saved = await api.save({ request: asked, source: board.diagram, language: languageSelect.value }).catch(() => null);
    revealButton.hidden = !saved?.ok;
  } finally {
    setBusy(false);
    if (queued !== null) {
      const next = queued;
      queued = null;
      request.value = next;
      void submit();
    }
  }
}

function clear() {
  if (busy) return;
  board = emptyBoard();
  diagram.replaceChildren();
  sourceView.textContent = "";
  emptyNote.hidden = false;
  revealButton.hidden = true;
  showError("");
  setStatus("");
}

try {
  const saved = localStorage.getItem(LANGUAGE_KEY);
  if (saved === "uk" || saved === "en") languageSelect.value = saved;
} catch {
  // Storage unavailable: the select stays on Auto.
}
languageSelect.addEventListener("change", () => {
  try {
    localStorage.setItem(LANGUAGE_KEY, languageSelect.value);
  } catch {
    // Not remembered; the choice still applies to this window.
  }
});

drawButton.addEventListener("click", () => void submit());
request.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void submit();
  }
});
document.getElementById("clear-btn").addEventListener("click", clear);
revealButton.addEventListener("click", () => void api.reveal());
document.getElementById("close-btn").addEventListener("click", () => void api.close());
api.onRequest?.((_event, payload) => {
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (text === "") return;
  if (busy) {
    queued = text;
    return;
  }
  request.value = text;
  void submit();
});
window.addEventListener("marshal:language", () => setStatus(statusKey));
window.MarshalIcons?.apply();
request.focus();
