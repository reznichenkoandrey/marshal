// 5-hour usage for the plan runner (#278), read from the statusline JSON that
// Marshal's wrapper stores per session (#268, claude-code/statusline.ts).
// Read on a tick of a running plan only; nothing here watches or polls.

import fs from "node:fs";
import path from "node:path";

/**
 * `rate_limits.five_hour.used_percentage` of one statusline payload, or null
 * when it has none (API-key sessions, old Claude Code). A window that has
 * already reset counts as 0: the stored number belongs to the previous window.
 */
export function usageFromStatus(status: unknown, now: number): number | null {
  const window = (status as { rate_limits?: { five_hour?: { used_percentage?: unknown; resets_at?: unknown } } } | null)
    ?.rate_limits?.five_hour;
  const used = window?.used_percentage;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  const resetsAt = window?.resets_at;
  // Claude Code writes resets_at in epoch seconds.
  if (typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt * 1000 <= now) return 0;
  return Math.max(0, Math.min(100, used));
}

/** Usage from the most recently written session file that carries it; null = unknown. */
export function readUsagePct(usageDir: string, now: number): number | null {
  let files: { file: string; mtime: number }[];
  try {
    files = fs
      .readdirSync(usageDir)
      .filter((name) => name.endsWith(".json") && name !== "previous-statusline.json")
      .map((name) => {
        const file = path.join(usageDir, name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }
  for (const { file } of files) {
    try {
      const pct = usageFromStatus(JSON.parse(fs.readFileSync(file, "utf8")) as unknown, now);
      if (pct !== null) return pct;
    } catch {
      // A file caught mid-write or not JSON: the next one may still answer.
    }
  }
  return null;
}
