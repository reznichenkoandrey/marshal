// desktop/renderer/board-ops.js
//
// Pure core of voice boards (#276, docs/VOICE_BOARDS.md §2.1 and §3): the op
// stream parser, op application and the parse-then-render flow with one
// repair retry. No DOM, no Electron and no Mermaid here — board.js injects
// those, and vitest imports this file directly.

export const NODE_TYPES = ["idea", "question", "decision", "risk", "task"];

const FENCE_OPEN = /^```\s*mermaid\s*$/iu;
const FENCE_CLOSE = /^```\s*$/u;

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isType = (value) => NODE_TYPES.includes(value);
const textItems = (value) => (Array.isArray(value) ? value.filter(isText).map((item) => item.trim()) : null);

/**
 * A validated copy of one op, or null when it is unknown or malformed.
 * Only the documented fields survive, so model text never adds keys to the board.
 */
export function normalizeOp(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  switch (raw.op) {
    case "addNode":
      if (!isText(raw.id) || !isText(raw.label)) return null;
      return { op: "addNode", id: raw.id.trim(), label: raw.label.trim(), type: isType(raw.type) ? raw.type : "idea" };
    case "updateNode": {
      if (!isText(raw.id)) return null;
      const op = { op: "updateNode", id: raw.id.trim() };
      if (isText(raw.label)) op.label = raw.label.trim();
      if (isType(raw.type)) op.type = raw.type;
      return op;
    }
    case "removeNode":
      return isText(raw.id) ? { op: "removeNode", id: raw.id.trim() } : null;
    case "addEdge": {
      if (!isText(raw.from) || !isText(raw.to)) return null;
      const op = { op: "addEdge", from: raw.from.trim(), to: raw.to.trim() };
      if (isText(raw.label)) op.label = raw.label.trim();
      return op;
    }
    case "removeEdge":
      return isText(raw.from) && isText(raw.to) ? { op: "removeEdge", from: raw.from.trim(), to: raw.to.trim() } : null;
    case "setSummary":
      return typeof raw.text === "string" ? { op: "setSummary", text: raw.text.trim() } : null;
    case "setTasks":
    case "setQuestions": {
      const items = textItems(raw.items);
      return items ? { op: raw.op, items } : null;
    }
    case "setDiagram":
      return isText(raw.mermaid) ? { op: "setDiagram", mermaid: raw.mermaid.trim() } : null;
    default:
      return null;
  }
}

/**
 * Incremental parser of model output. `push` returns the ops completed by this
 * chunk: one JSON object per finished line, or one `setDiagram` per closed
 * ```mermaid fence. A partial line or an open fence is never returned. `end`
 * treats the remaining text as a finished line; an unclosed fence is dropped.
 * `dropped` collects the lines that looked like ops but were not valid.
 */
export function createOpStream() {
  let buffer = "";
  let fence = null;
  const dropped = [];

  function takeLine(line) {
    if (fence) {
      if (!FENCE_CLOSE.test(line.trim())) {
        fence.push(line);
        return null;
      }
      const op = normalizeOp({ op: "setDiagram", mermaid: fence.join("\n") });
      fence = null;
      return op;
    }
    const trimmed = line.trim();
    if (FENCE_OPEN.test(trimmed)) {
      fence = [];
      return null;
    }
    if (!trimmed.startsWith("{")) return null;
    let op = null;
    try {
      op = normalizeOp(JSON.parse(trimmed));
    } catch {
      op = null;
    }
    if (!op) dropped.push(trimmed);
    return op;
  }

  function drain(lines) {
    return lines.map(takeLine).filter(Boolean);
  }

  return {
    dropped,
    push(chunk) {
      buffer += String(chunk ?? "");
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      return drain(lines);
    },
    end() {
      const rest = buffer;
      buffer = "";
      const ops = rest === "" ? [] : drain([rest]);
      fence = null;
      return ops;
    }
  };
}

/** Every op in a complete text, plus the lines that were dropped. */
export function parseOps(text) {
  const stream = createOpStream();
  const ops = [...stream.push(text), ...stream.end()];
  return { ops, dropped: stream.dropped };
}

export function emptyBoard() {
  return { nodes: [], edges: [], summary: "", tasks: [], questions: [], diagram: "" };
}

const sameEdge = (edge, op) => edge.from === op.from && edge.to === op.to;

/** The board after one op. Never mutates its input; an op that changes nothing returns it as is. */
export function applyOp(board, op) {
  switch (op?.op) {
    case "addNode": {
      const node = { id: op.id, label: op.label, type: op.type };
      // A duplicate id is an update (spec §2.1), and keeps the node's position in the list.
      return board.nodes.some((item) => item.id === op.id)
        ? { ...board, nodes: board.nodes.map((item) => (item.id === op.id ? node : item)) }
        : { ...board, nodes: [...board.nodes, node] };
    }
    case "updateNode":
      if (!board.nodes.some((item) => item.id === op.id)) return board;
      return {
        ...board,
        nodes: board.nodes.map((item) =>
          item.id === op.id ? { ...item, label: op.label ?? item.label, type: op.type ?? item.type } : item
        )
      };
    case "removeNode":
      return {
        ...board,
        nodes: board.nodes.filter((item) => item.id !== op.id),
        edges: board.edges.filter((edge) => edge.from !== op.id && edge.to !== op.id)
      };
    case "addEdge": {
      const known = (id) => board.nodes.some((item) => item.id === id);
      if (!known(op.from) || !known(op.to)) return board;
      const edge = op.label ? { from: op.from, to: op.to, label: op.label } : { from: op.from, to: op.to };
      return { ...board, edges: [...board.edges.filter((item) => !sameEdge(item, op)), edge] };
    }
    case "removeEdge":
      return { ...board, edges: board.edges.filter((item) => !sameEdge(item, op)) };
    case "setSummary":
      return { ...board, summary: op.text };
    case "setTasks":
      return { ...board, tasks: op.items };
    case "setQuestions":
      return { ...board, questions: op.items };
    case "setDiagram":
      return { ...board, diagram: op.mermaid };
    default:
      return board;
  }
}

export function applyOps(board, ops) {
  return ops.reduce(applyOp, board);
}

/** Mermaid source from a model reply: the last fenced block or `setDiagram` op, else the reply itself. */
export function diagramFromReply(text) {
  const { ops } = parseOps(text);
  const last = ops.filter((op) => op.op === "setDiagram").pop();
  return last ? last.mermaid : String(text ?? "").trim();
}

const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Parse-then-render with one repair retry (spec §3.3). `parse` throws on bad
 * source; `repair(source, error)` asks the model for a fix and returns its
 * reply, or null. `repair` runs at most once: a second failure returns the
 * error and the caller keeps its last good render.
 */
export async function resolveDiagram({ source, parse, repair }) {
  try {
    await parse(source);
    return { ok: true, source, repaired: false };
  } catch (err) {
    const firstError = messageOf(err);
    let reply = null;
    try {
      reply = await repair(source, firstError);
    } catch {
      reply = null;
    }
    const fixed = isText(reply) ? diagramFromReply(reply) : "";
    if (fixed === "") return { ok: false, error: firstError, repaired: false };
    try {
      await parse(fixed);
      return { ok: true, source: fixed, repaired: true };
    } catch (second) {
      return { ok: false, error: messageOf(second), repaired: true };
    }
  }
}

const MERMAID_START =
  /^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|gantt|mindmap|timeline)\b/u;

/**
 * Ops typed straight into the text box (Stage 1 dev input): op lines, a fenced
 * block or bare Mermaid source. Empty for a plain request, which goes to the model.
 */
export function directOps(text) {
  const { ops } = parseOps(text);
  if (ops.length > 0) return ops;
  const source = String(text ?? "").trim();
  return MERMAID_START.test(source) ? [{ op: "setDiagram", mermaid: source }] : [];
}

/**
 * Positions of the idea map (brainstorm mode, spec §6: own canvas, no library).
 * A left-to-right tree: depth is the column, leaves take the next free row and
 * a parent sits in the middle of its children. A node's parent is its first
 * incoming edge; other edges are still drawn, they just do not move anything.
 */
export function layoutBoard(board, size = {}) {
  const { width = 190, height = 68, gapX = 70, gapY = 18 } = size;
  const ids = board.nodes.map((node) => node.id);
  const children = new Map(ids.map((id) => [id, []]));
  const hasParent = new Set();
  for (const edge of board.edges) {
    if (!children.has(edge.from) || !children.has(edge.to) || edge.from === edge.to || hasParent.has(edge.to)) continue;
    children.get(edge.from).push(edge.to);
    hasParent.add(edge.to);
  }
  const placed = new Map();
  let nextRow = 0;
  const place = (id, depth) => {
    const slot = { depth, row: 0 };
    placed.set(id, slot);
    const rows = children.get(id).filter((child) => !placed.has(child)).map((child) => place(child, depth + 1));
    slot.row = rows.length > 0 ? (rows[0] + rows[rows.length - 1]) / 2 : nextRow++;
    return slot.row;
  };
  for (const id of ids) if (!hasParent.has(id)) place(id, 0);
  // Nodes that are reachable only through a cycle have no root of their own.
  for (const id of ids) if (!placed.has(id)) place(id, 0);
  const nodes = ids.map((id) => {
    const slot = placed.get(id);
    return { id, x: slot.depth * (width + gapX), y: slot.row * (height + gapY) };
  });
  return {
    nodes,
    width: nodes.reduce((max, node) => Math.max(max, node.x + width), 0),
    height: nodes.reduce((max, node) => Math.max(max, node.y + height), 0)
  };
}
