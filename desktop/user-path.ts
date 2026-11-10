import path from "node:path";

/**
 * An app started from Finder gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * so CLIs spawned by bare name (`claude`, `codex`) are not found (#349). Appends
 * where their installers put them; directories already on PATH keep their order.
 */
export function withUserBinDirs(current: string | undefined, home: string): string {
  const dirs = (current ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs.join(path.delimiter);
}
