import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asarUnpacked } from "../utils/asar-paths.ts";

const DEFAULT_BIN = path.join(asarUnpacked(path.dirname(fileURLToPath(import.meta.url))), "mic-users");
const TIMEOUT_MS = 1_500;
// The first exec of a freshly signed helper waits on Gatekeeper for up to ~35 s (#181).
const WARM_UP_TIMEOUT_MS = 60_000;
// Phrases come in bursts (a session event and its reminder); one probe covers them.
const CACHE_MS = 2_000;

// Siri, Voice Control and system dictation hold the mic all the time; they are not calls.
const NOT_CALLS = new Set(["corespeechd", "speechrecognitiond", "localspeechrecognition"]);

export type MicUser = { pid: number; ppid: number; name: string; bundleId: string };

/** Tab-separated lines of `mic-users`: pid, parent pid, executable name, bundle id (empty for bare executables). */
export function parseMicUsers(stdout: string): MicUser[] {
  const users: MicUser[] = [];
  for (const line of stdout.split("\n")) {
    const [pid, ppid, name = "", bundleId = ""] = line.split("\t");
    if (/^\d+$/.test(pid ?? "") && /^\d+$/.test(ppid ?? "")) {
      users.push({ pid: Number(pid), ppid: Number(ppid), name: name.trim(), bundleId: bundleId.trim() });
    }
  }
  return users;
}

/**
 * On a call = some process outside Marshal captures audio input. Marshal's own
 * capture (dictation recorder, the home window's level meter) runs in the main
 * process or its direct children.
 */
export function isOnCall(users: MicUser[], ownPid: number): boolean {
  return users.some((user) => user.pid !== ownPid && user.ppid !== ownPid && !NOT_CALLS.has(user.name.toLowerCase()));
}

export type CallPresenceOptions = { binPath?: string; ownPid?: number; now?: () => number };

/** A probe that runs the helper on demand — no poller, no resident process (#281). Unknown = not on a call. */
export function createCallPresence(options: CallPresenceOptions = {}): () => Promise<boolean> {
  const binPath = options.binPath ?? DEFAULT_BIN;
  const ownPid = options.ownPid ?? process.pid;
  const now = options.now ?? Date.now;
  let cached: { at: number; value: Promise<boolean> } | null = null;
  return () => {
    if (cached && now() - cached.at < CACHE_MS) return cached.value;
    const value = new Promise<boolean>((resolve) => {
      execFile(binPath, [], { timeout: TIMEOUT_MS }, (err, stdout) => {
        if (err) console.warn("[presence] mic-users failed:", err.message);
        resolve(!err && isOnCall(parseMicUsers(stdout), ownPid));
      });
    });
    cached = { at: now(), value };
    return value;
  };
}

/** Pays the first-exec Gatekeeper check in the background, so the first real probe is fast. */
export function warmUpMicUsers(binPath = DEFAULT_BIN): void {
  execFile(binPath, [], { timeout: WARM_UP_TIMEOUT_MS }, () => {});
}
