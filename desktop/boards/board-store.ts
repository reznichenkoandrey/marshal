// Saved boards (#276, Stage 2 of docs/VOICE_BOARDS.md §5 and §7): one folder
// per drawn diagram under `<userData>/boards/<id>/` with `board.mmd` (the
// Mermaid source) and `board.json` (what was asked). No Electron here; the
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
  /** Absolute path of `board.mmd`. */
  file: string;
}

export interface BoardInput {
  request: string;
  source: string;
  language: BoardLanguage;
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
  const source = input.source.trim();
  if (source === "" || source.length > MAX_SOURCE_CHARS) return null;
  const id = boardId(now);
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "board.mmd");
  fs.writeFileSync(file, `${source}\n`, "utf8");
  const meta = {
    id,
    request: input.request.trim().slice(0, MAX_REQUEST_CHARS),
    language: input.language,
    savedAt: now.toISOString()
  };
  fs.writeFileSync(path.join(dir, "board.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  for (const name of planBoardPrune(fs.readdirSync(root))) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  return { id, dir, file };
}
