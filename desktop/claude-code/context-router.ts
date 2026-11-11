// Which Claude Code sessions Marshal may read (#303): their transcripts feed
// the dossiers the voice dispatcher's `./marshal context` describes (#286, #318).

import os from "node:os";
import path from "node:path";

/** One folder per line; `~/` is the home folder. Blank lines and relative paths are ignored. */
export function parseRoutingRoots(text: string, home = os.homedir()): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map((line) => (line === "~" || line.startsWith("~/") ? path.join(home, line.slice(1)) : line))
    .filter((line) => path.isAbsolute(line))
    .map((line) => path.resolve(line));
}

/**
 * Only sessions under an allowed folder have their transcripts read (#303):
 * one Claude Code install can hold sessions of different employers, and a
 * transcript must not leave through another workspace's key. No folders =
 * no session is read.
 */
export function isUnderRoots(cwd: string, roots: readonly string[]): boolean {
  const dir = path.resolve(cwd);
  return roots.some((root) => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}
