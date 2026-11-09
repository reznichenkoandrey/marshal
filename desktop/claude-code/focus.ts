// Bring a Claude Code session's window to the front: the exact Terminal/iTerm
// tab when the session runs on a tty, otherwise the app that hosts it (Claude
// desktop, VS Code, …). Desktop sessions have no tty, so for them the app is
// as close as macOS lets us get.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessRow = { pid: number; ppid: number; tty: string | null; command: string };

export type FocusTarget = {
  tty: string | null;
  // Outermost .app bundle among the session's ancestors.
  appPath: string | null;
};

const TTY_PATTERN = /^ttys\d+$/;

/** Parse `ps -axo pid=,ppid=,tty=,comm=`; the command may contain spaces. */
export function parseProcessTable(output: string): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    rows.set(pid, {
      pid,
      ppid: Number(match[2]),
      tty: TTY_PATTERN.test(match[3]) ? match[3] : null,
      command: match[4].trim()
    });
  }
  return rows;
}

function bundleOf(command: string): string | null {
  const index = command.indexOf(".app/");
  return index === -1 ? null : command.slice(0, index + ".app".length);
}

export function findFocusTarget(rows: Map<number, ProcessRow>, pid: number): FocusTarget {
  const self = rows.get(pid);
  let tty = self?.tty ?? null;
  let appPath: string | null = null;
  // The claude binary itself ships inside a claude.app, so start at the parent.
  let current = self ? rows.get(self.ppid) : undefined;
  const seen = new Set<number>([pid]);
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    tty ??= current.tty;
    appPath = bundleOf(current.command) ?? appPath;
    current = current.ppid > 1 ? rows.get(current.ppid) : undefined;
  }
  return { tty, appPath };
}

export function terminalTabScript(appPath: string, tty: string): string | null {
  if (!TTY_PATTERN.test(tty)) return null;
  const device = `/dev/${tty}`;
  if (appPath.endsWith("/Terminal.app")) {
    return [
      `tell application "${appPath}"`,
      "  repeat with w in windows",
      "    repeat with t in tabs of w",
      `      if tty of t is "${device}" then`,
      "        set selected of t to true",
      "        set index of w to 1",
      "        activate",
      "        return true",
      "      end if",
      "    end repeat",
      "  end repeat",
      "end tell",
      "return false"
    ].join("\n");
  }
  if (appPath.endsWith("/iTerm.app")) {
    return [
      `tell application "${appPath}"`,
      "  repeat with w in windows",
      "    repeat with t in tabs of w",
      "      repeat with s in sessions of t",
      `        if tty of s is "${device}" then`,
      "          select w",
      "          tell t to select",
      "          tell s to select",
      "          activate",
      "          return true",
      "        end if",
      "      end repeat",
      "    end repeat",
      "  end repeat",
      "end tell",
      "return false"
    ].join("\n");
  }
  return null;
}

export async function focusSession(pid: number): Promise<boolean> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,tty=,comm="]);
  const target = findFocusTarget(parseProcessTable(stdout), pid);
  if (!target.appPath) return false;

  const script = target.tty ? terminalTabScript(target.appPath, target.tty) : null;
  if (script) {
    try {
      const { stdout: found } = await execFileAsync("osascript", ["-e", script]);
      if (found.trim() === "true") return true;
    } catch (err) {
      // Automation permission denied or the app's dictionary changed: the
      // app itself is still worth bringing forward.
      console.warn("[claude-sessions] tab focus failed:", err instanceof Error ? err.message : err);
    }
  }
  await execFileAsync("open", ["-a", target.appPath]);
  return true;
}
