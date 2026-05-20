// desktop/utils/asar-paths.ts
//
// Rewrite a path that lives inside `app.asar/` to its on-disk counterpart in
// `app.asar.unpacked/`. Electron makes the asar archive transparent to
// `fs.readFile` and friends via its asar→asar.unpacked redirect, but
// `child_process.spawn` / `execFile` go straight to the OS `execve` syscall,
// which cannot descend into a .asar file and fails with `ENOTDIR`.
//
// Any module that resolves a native helper binary from `import.meta.url` MUST
// run that path through `asarUnpacked()` before handing it to `spawn`. In dev
// builds (no asar at all) and in tests the function is a no-op, so callers
// don't need to branch.
//
// Background: #82.

import path from "node:path";

const ASAR_SEGMENT = `${path.sep}app.asar${path.sep}`;
const UNPACKED_SEGMENT = `${path.sep}app.asar.unpacked${path.sep}`;

export function asarUnpacked(p: string): string {
  return p.includes(ASAR_SEGMENT) ? p.replace(ASAR_SEGMENT, UNPACKED_SEGMENT) : p;
}
