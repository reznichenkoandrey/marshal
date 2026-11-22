// Saved boards (#276, docs/VOICE_BOARDS.md §5 and §7): one folder per board
// under `<userData>/boards/<id>/`. A diagram is `board.mmd` (the Mermaid
// source) plus `board.json` (what was asked); a brainstorm is `board.json`
// with the idea map, rewritten in place as the brainstorm grows. No Electron here; the
// window passes the root folder in. Nothing is read at idle: files are written
// on a successful draw and pruned in the same call.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { BoardLanguage } from "./board-prompt.ts";

// Spec §11.8: oldest boards beyond this are pruned.
export const MAX_BOARDS = 100;
const MAX_SOURCE_CHARS = 20_000;
const MAX_REQUEST_CHARS = 4000;
const ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/u;

export interface SavedBoard {
  id: string;
  dir: string;
  /** Absolute path of `board.mmd`, or of `board.json` for a brainstorm. */
  file: string;
}

export const NODE_TYPES = ["idea", "question", "decision", "risk", "task"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** The idea map of a brainstorm; the same shape board-ops.js keeps in the window. */
export interface BoardState {
  nodes: { id: string; label: string; type: NodeType }[];
  edges: { from: string; to: string; label?: string }[];
  summary: string;
  tasks: string[];
  questions: string[];
}

export interface BoardInput {
  request: string;
  language: BoardLanguage;
  /** Diagram mode: the Mermaid source. */
  source?: string;
  /** Brainstorm mode: the idea map. */
  state?: BoardState;
  /** A brainstorm saved earlier in this window: its folder is rewritten instead of a new one. */
  id?: string;
}

const MAX_NODES = 200;
const MAX_ITEMS = 50;
const MAX_LABEL_CHARS = 300;
const MAX_SUMMARY_CHARS = 2000;

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const items = (value: unknown): string[] =>
  list(value).map((item) => text(item, MAX_LABEL_CHARS)).filter((item) => item !== "").slice(0, MAX_ITEMS);

/** A board state rebuilt field by field: what came over IPC is never written or sent to the model as is. */
export function sanitizeBoardState(value: unknown): BoardState {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const nodes: BoardState["nodes"] = [];
  for (const item of list(raw.nodes).slice(0, MAX_NODES)) {
    const node = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const id = text(node.id, 64);
    const label = text(node.label, MAX_LABEL_CHARS);
    if (id === "" || label === "" || nodes.some((known) => known.id === id)) continue;
    const type = NODE_TYPES.find((known) => known === node.type) ?? "idea";
    nodes.push({ id, label, type });
  }
  const known = new Set(nodes.map((node) => node.id));
  const edges: BoardState["edges"] = [];
  for (const item of list(raw.edges).slice(0, MAX_NODES * 2)) {
    const edge = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const from = text(edge.from, 64);
    const to = text(edge.to, 64);
    if (!known.has(from) || !known.has(to)) continue;
    const label = text(edge.label, MAX_LABEL_CHARS);
    edges.push(label ? { from, to, label } : { from, to });
  }
  return { nodes, edges, summary: text(raw.summary, MAX_SUMMARY_CHARS), tasks: items(raw.tasks), questions: items(raw.questions) };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Sortable by time as plain text, so pruning needs no index file. */
export function boardId(now: Date, suffix = randomBytes(2).toString("hex")): string {
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${day}-${time}-${suffix}`;
}

/** Folders to delete so that `keep` newest remain. Only names this module made are ever returned. */
export function planBoardPrune(names: string[], keep = MAX_BOARDS): string[] {
  const own = names.filter((name) => ID_PATTERN.test(name)).sort();
  return own.slice(0, Math.max(0, own.length - keep));
}

/** Writes one board and prunes the oldest. Null when there is nothing to save. */
export function saveBoard(root: string, input: BoardInput, now = new Date()): SavedBoard | null {
  const source = (input.source ?? "").trim();
  const state = input.state;
  if (state ? state.nodes.length === 0 : source === "" || source.length > MAX_SOURCE_CHARS) return null;
  // Only an id this module made, and only while its folder still exists.
  const reuse = input.id !== undefined && ID_PATTERN.test(input.id) && fs.existsSync(path.join(root, input.id));
  const id = reuse && input.id ? input.id : boardId(now);
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, "board.json");
  const file = state ? json : path.join(dir, "board.mmd");
  if (!state) fs.writeFileSync(file, `${source}\n`, "utf8");
  const meta = {
    id,
    mode: state ? "brainstorm" : "diagram",
    request: input.request.trim().slice(0, MAX_REQUEST_CHARS),
    language: input.language,
    savedAt: now.toISOString(),
    ...(state ? { board: state } : {})
  };
  fs.writeFileSync(json, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  for (const name of planBoardPrune(fs.readdirSync(root))) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  return { id, dir, file };
}
