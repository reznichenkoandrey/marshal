// Board window (#276): a spoken or typed request drives one Mermaid diagram,
// or, in brainstorm mode, grows an idea map thought by thought. Everything
// that decides something lives in board-ops.js; this file wires it to the DOM,
// to main (model calls) and to Mermaid, which is imported only when the first
// diagram is drawn.

import {
  applyOps,
  createOpStream,
  diagramFromReply,
  directOps,
  emptyBoard,
  layoutBoard,
  parseOps,
  resolveDiagram
} from "./board-ops.js";

const api = window.marshalBoard;
const t = (key, params) => window.MarshalI18n.t(key, params);
const LANGUAGE_KEY = "marshal.board.language";
const MODE_KEY = "marshal.board.mode";
const ROLE_KEY = "marshal.board.role";
const NODE_SIZE = { width: 190, height: 68, gapX: 70, gapY: 18 };
const SVG_NS = "http://www.w3.org/2000/svg";

const request = document.getElementById("request");
const drawButton = document.getElementById("draw-btn");
const languageSelect = document.getElementById("board-language");
const statusLine = document.getElementById("status");
const errorLine = document.getElementById("error");
const diagram = document.getElementById("diagram");
const emptyNote = document.getElementById("empty");
const sourceView = document.getElementById("source");
const revealButton = document.getElementById("reveal-btn");
const modeSelect = document.getElementById("board-mode");
const roleSelect = document.getElementById("board-role");
const map = document.getElementById("map");
const mapEdges = document.getElementById("map-edges");
const panels = document.getElementById("panels");

let board = emptyBoard();
let busy = false;
let renderCount = 0;
let mermaidLoad = null;
let statusKey = "";
// A spoken request that arrived while another one was being drawn; the newest wins.
let queued = null;
// Brainstorm: the op stream of the reply being written, and the saved board this window keeps rewriting.
let live = null;
let savedId;

const isBrainstorm = () => modeSelect.value === "brainstorm";

function setMode(mode) {
  modeSelect.value = mode === "brainstorm" ? "brainstorm" : "diagram";
  const brainstorm = isBrainstorm();
  roleSelect.hidden = !brainstorm;
  document.getElementById("diagram-stage").hidden = brainstorm;
  document.getElementById("map-stage").hidden = !brainstorm;
  drawButton.textContent = t(brainstorm ? "board.add" : "board.draw");
  request.placeholder = t(brainstorm ? "board.thoughtPlaceholder" : "board.requestPlaceholder");
}

function fillList(id, items) {
  const list = document.getElementById(id);
  list.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("li");
      row.textContent = item;
      return row;
    })
  );
  document.getElementById(`${id}-panel`).hidden = items.length === 0;
}

/** The idea map from the board state. Model text reaches the page only through textContent. */
function renderMap() {
  const layout = layoutBoard(board, NODE_SIZE);
  const at = new Map(layout.nodes.map((node) => [node.id, node]));
  map.style.width = `${layout.width}px`;
  map.style.height = `${layout.height}px`;
  const cards = board.nodes.map((node) => {
    const spot = at.get(node.id);
    const card = document.createElement("div");
    card.className = "board-node";
    card.dataset.type = node.type;
    card.dataset.id = node.id;
    card.title = node.label;
    card.style.cssText = `left:${spot.x}px;top:${spot.y}px;width:${NODE_SIZE.width}px;height:${NODE_SIZE.height}px`;
    const type = document.createElement("span");
    type.className = "board-node-type";
    type.textContent = t(`board.type.${node.type}`);
    const label = document.createElement("span");
    label.className = "board-node-label";
    label.textContent = node.label;
    card.append(type, label);
    return card;
  });
  const lines = board.edges.flatMap((edge) => {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (!from || !to) return [];
    const startX = from.x + NODE_SIZE.width;
    const startY = from.y + NODE_SIZE.height / 2;
    const endY = to.y + NODE_SIZE.height / 2;
    const bend = Math.max(30, Math.abs(to.x - startX) / 2);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${startX} ${startY} C ${startX + bend} ${startY}, ${to.x - bend} ${endY}, ${to.x} ${endY}`);
    if (!edge.label) return [path];
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String((startX + to.x) / 2));
    text.setAttribute("y", String((startY + endY) / 2 - 4));
    text.textContent = edge.label;
    return [path, text];
  });
  mapEdges.replaceChildren(...lines);
  map.replaceChildren(mapEdges, ...cards);
  document.getElementById("map-empty").hidden = board.nodes.length > 0;
  document.getElementById("summary").textContent = board.summary;
  document.getElementById("summary-panel").hidden = board.summary === "";
  fillList("tasks", board.tasks);
  fillList("questions", board.questions);
  panels.hidden = board.summary === "" && board.tasks.length === 0 && board.questions.length === 0;
}

const mapState = () => ({
  nodes: board.nodes,
  edges: board.edges,
  summary: board.summary,
  tasks: board.tasks,
  questions: board.questions
});

/** One thought → ops. The map grows while the model writes; the full reply is what counts in the end. */
async function addThought(text) {
  const before = board;
  let ops = directOps(text).filter((op) => op.op !== "setDiagram");
  if (ops.length === 0) {
    setStatus("board.status.mapping");
    live = createOpStream();
    const reply = await api.brainstorm({ text, role: roleSelect.value, language: languageSelect.value, board: mapState() });
    live = null;
    if (!reply.ok) {
      board = before;
      renderMap();
      setStatus("");
      showError(reply.error);
      return;
    }
    ops = parseOps(reply.text).ops.filter((op) => op.op !== "setDiagram");
  }
  board = applyOps(before, ops);
  renderMap();
  if (ops.length === 0) {
    setStatus("");
    showError(t("board.error.noOps"));
    return;
  }
  setStatus("board.status.done");
  if (board.nodes.length === 0) return;
  // One brainstorm is one saved board: the same folder is rewritten after every thought.
  const saved = await api.save({ request: text, language: languageSelect.value, board: mapState(), id: savedId }).catch(() => null);
  if (saved?.ok) savedId = saved.id;
  revealButton.hidden = !saved?.ok;
}

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
    if (isBrainstorm()) {
      await addThought(text);
      if (!errorLine.hidden) return;
      request.value = "";
      return;
    }
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
      setMode(next.mode);
      request.value = next.text;
      void submit();
    }
  }
}

function clear() {
  if (busy) return;
  board = emptyBoard();
  savedId = undefined;
  renderMap();
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

function remember(select, key, values) {
  try {
    const saved = localStorage.getItem(key);
    if (values.includes(saved)) select.value = saved;
  } catch {
    // Storage unavailable: the select keeps its default.
  }
  select.addEventListener("change", () => {
    try {
      localStorage.setItem(key, select.value);
    } catch {
      // Not remembered; the choice still applies to this window.
    }
  });
}
remember(modeSelect, MODE_KEY, ["diagram", "brainstorm"]);
remember(roleSelect, ROLE_KEY, ["both", "structure", "challenge"]);
modeSelect.addEventListener("change", () => setMode(modeSelect.value));
setMode(modeSelect.value);

api.onDelta?.((_event, payload) => {
  if (!live || typeof payload?.delta !== "string") return;
  const ops = live.push(payload.delta).filter((op) => op.op !== "setDiagram");
  if (ops.length === 0) return;
  board = applyOps(board, ops);
  renderMap();
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
  const mode = payload?.mode === "brainstorm" ? "brainstorm" : "diagram";
  if (busy) {
    if (text !== "") queued = { text, mode };
    return;
  }
  setMode(mode);
  if (text === "") return;
  request.value = text;
  void submit();
});
window.addEventListener("marshal:language", () => {
  setStatus(statusKey);
  setMode(modeSelect.value);
  renderMap();
});
window.MarshalIcons?.apply();
request.focus();
