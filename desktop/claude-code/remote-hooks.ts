// Stop / Notification hooks on an allowed remote host (#288, the host half of
// stage 2 of docs/REMOTE_SESSIONS.md). The hook is a sh script that writes a
// small record into a spool on that host; Marshal collects the spool with one
// ssh exec when asked. Nothing listens on the host and no tunnel stays open
// (#281). Not wired into main yet: installing writes to another machine, so it
// waits for the owner's live check of stage 1 and a per-host button.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseHookPayload, SPOOL_MAX_AGE_MS, type HookEvent } from "./hook-events.ts";
import { dropHooks, HOOK_EVENTS } from "./hook-installer.ts";
import {
  classifyRemoteError,
  EXEC_TIMEOUT_MS,
  isUnderRemoteRoots,
  MAX_OUTPUT_BYTES,
  resolveRoots,
  sshArgs,
  type RemoteError,
  type RemoteHost
} from "./remote-source.ts";

export const REMOTE_HOOK_SCRIPT_NAME = "marshal-remote-hook.sh";
// A constant: `$HOME` is expanded by the shell that runs the hook on the host,
// so no path reported by the host ever becomes part of a command.
export const REMOTE_HOOK_COMMAND = `/bin/sh "$HOME/.claude/marshal-remote/${REMOTE_HOOK_SCRIPT_NAME}"`;

// The record holds the event kind, the session id, the folder and the
// notification type. The assistant's last message and the notification text
// stay on the host: sending conversation content is a separate decision (§3).
export const REMOTE_HOOK_SCRIPT = [
  "#!/bin/sh",
  "# Marshal: notes a Claude Code Stop / Notification event for Marshal on another machine.",
  "# Installed and removed by Marshal over ssh; safe to delete together with this folder.",
  "umask 077",
  'd="$HOME/.claude/marshal-remote/spool"',
  "payload=$(cat)",
  "field() {",
  "  printf '%s' \"$payload\" | sed -n \"s/.*\\\"$1\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p\" | head -n 1",
  "}",
  "e=$(field hook_event_name)",
  "s=$(field session_id)",
  '[ -n "$e" ] && [ -n "$s" ] || exit 0',
  'mkdir -p "$d" || exit 0',
  "# Marshal drops events older than 15 minutes, so the spool never needs them either.",
  'find "$d" -type f -mmin +15 -exec rm -f {} + 2>/dev/null',
  '[ "$(ls "$d" | wc -l)" -lt 200 ] || exit 0',
  "now=$(date +%s)",
  'tmp="$d/.$$.tmp"',
  "printf '{\"e\":\"%s\",\"s\":\"%s\",\"c\":\"%s\",\"n\":\"%s\",\"t\":%s}\\n' \\",
  '  "$e" "$s" "$(field cwd)" "$(field notification_type)" "$now" > "$tmp" && mv "$tmp" "$d/$now-$$.ev"',
  ""
].join("\n");

export const REMOTE_HOOK_SCRIPT_HASH = createHash("sha256").update(REMOTE_HOOK_SCRIPT).digest("hex");

// Remote commands. Constants, single quotes only around the whole script, and
// every answer is a `marshal <word>` line so a login banner cannot pass for one.
const PATHS = 'd="$HOME/.claude/marshal-remote"; s="$HOME/.claude/settings.json"; ';
// A file sent on stdin starts with its byte count: a dropped connection must
// not leave half a settings.json behind.
const RECEIVE = (file: string): string =>
  `read n; cat > "$d/${file}" || exit 1; ` +
  `[ "$(wc -c < "$d/${file}" | tr -d " ")" = "$n" ] || { rm -f "$d/${file}"; echo "marshal truncated"; exit 0; }; `;

/** Copies settings.json aside (the copy later proves it did not change) and prints it. */
export const REMOTE_PREPARE_COMMAND =
  "sh -c '" +
  "umask 077; " +
  PATHS +
  '[ -L "$s" ] && { echo "marshal symlink"; exit 0; }; ' +
  'mkdir -p "$d" || exit 1; ' +
  'if [ -f "$s" ]; then cp "$s" "$d/settings.before" || exit 1; echo "marshal settings"; cat "$d/settings.before"; ' +
  'else rm -f "$d/settings.before"; echo "marshal absent"; fi' +
  "'";

export const REMOTE_PUT_SCRIPT_COMMAND =
  "sh -c '" +
  "umask 077; " +
  PATHS +
  RECEIVE("hook.tmp") +
  `mkdir -p "$d/spool" && mv "$d/hook.tmp" "$d/${REMOTE_HOOK_SCRIPT_NAME}" && echo "marshal ok"` +
  "'";

/** Replaces settings.json only if it is still the file REMOTE_PREPARE_COMMAND copied. */
export const REMOTE_PUT_SETTINGS_COMMAND =
  "sh -c '" +
  "umask 077; " +
  PATHS +
  RECEIVE("settings.new") +
  'fail() { rm -f "$d/settings.new"; echo "marshal $1"; exit 0; }; ' +
  '[ -L "$s" ] && fail symlink; ' +
  'if [ -f "$d/settings.before" ]; then cmp -s "$s" "$d/settings.before" || fail changed; ' +
  'else [ -e "$s" ] && fail changed; fi; ' +
  'mv "$d/settings.new" "$s" && rm -f "$d/settings.before" && echo "marshal ok"' +
  "'";

export const REMOTE_REMOVE_COMMAND = "sh -c 'rm -rf \"$HOME/.claude/marshal-remote\" && echo \"marshal ok\"'";

/** Prints and deletes the spooled events. Runs only on a host where the hooks were installed. */
export const REMOTE_DRAIN_COMMAND =
  "sh -c '" +
  'd="$HOME/.claude/marshal-remote/spool"; ' +
  'printf "home %s\\n" "$HOME"; printf "now %s\\n" "$(date +%s)"; ' +
  'for f in "$d"/*.ev; do [ -f "$f" ] || continue; ' +
  'printf "event\\n"; tr -d "\\n\\r" < "$f"; printf "\\n"; rm -f "$f"; ' +
  "done'";

type Settings = Record<string, unknown>;

function isRemoteHook(hook: unknown): boolean {
  const command = (hook as { command?: unknown } | null)?.command;
  return typeof command === "string" && command.includes(REMOTE_HOOK_SCRIPT_NAME);
}

/** Takes out only the remote hook: the owner's hooks and a local Marshal's own hooks on that machine stay. */
export function removeRemoteHooks(settings: Settings): Settings {
  return dropHooks(settings, HOOK_EVENTS, isRemoteHook);
}

/** Idempotent. Stop and Notification only: no remote PermissionRequest, so nothing remote is ever allowed by voice. */
export function addRemoteHooks(settings: Settings): Settings {
  const base = removeRemoteHooks(settings);
  const hooks: Record<string, unknown> =
    typeof base.hooks === "object" && base.hooks !== null && !Array.isArray(base.hooks)
      ? { ...(base.hooks as Record<string, unknown>) }
      : {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...groups, { hooks: [{ type: "command", command: REMOTE_HOOK_COMMAND, async: true }] }];
  }
  return { ...base, hooks };
}

export type RemoteHookError = RemoteError | "symlink" | "changed" | "truncated" | "settings";
export type RemoteHookResult = { ok: true } | { ok: false; error: RemoteHookError };

export type SshRun = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; input?: string }
) => Promise<{ stdout: string; stderr: string }>;

export type RemoteHookDeps = {
  run: SshRun;
  sshPath: string;
  /** Hosts with the hooks installed: `{ alias: { hash, installedAt } }`, 0600. */
  statePath: string;
  now: () => number;
};

const runSsh: SshRun = (file, args, { input, ...options }) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
  });

function withDefaults(deps: Partial<RemoteHookDeps> & { statePath: string }): RemoteHookDeps {
  return { run: runSsh, sshPath: "/usr/bin/ssh", now: () => Date.now(), ...deps };
}

export type RemoteHookState = Record<string, { hash: string; installedAt: number }>;

export function readRemoteHookState(statePath: string): RemoteHookState {
  try {
    const data = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as RemoteHookState) : {};
  } catch {
    return {};
  }
}

function writeRemoteHookState(statePath: string, state: RemoteHookState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, statePath);
}

/** The installed script differs from this build's: reinstall, on the owner's click only. */
export function remoteHooksOutdated(state: RemoteHookState, alias: string): boolean {
  return alias in state && state[alias].hash !== REMOTE_HOOK_SCRIPT_HASH;
}

async function exec(deps: RemoteHookDeps, alias: string, command: string, input?: string): Promise<string> {
  const body = input === undefined ? undefined : `${Buffer.byteLength(input)}\n${input}`;
  const { stdout } = await deps.run(deps.sshPath, sshArgs(alias, command, body !== undefined), {
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    input: body
  });
  return stdout;
}

/** The last `marshal <word>` line; anything else is not our script talking. */
function answerOf(stdout: string): string | null {
  const words = [...stdout.matchAll(/^marshal ([a-z]+)$/gmu)];
  return words.length > 0 ? words[words.length - 1][1] : null;
}

function asError(word: string | null): RemoteHookError {
  return word === "symlink" || word === "changed" || word === "truncated" ? word : "format";
}

type Prepared = { settings: Settings; indent: string; present: boolean };

async function prepare(deps: RemoteHookDeps, alias: string): Promise<Prepared | RemoteHookError> {
  const stdout = await exec(deps, alias, REMOTE_PREPARE_COMMAND);
  const marker = /^marshal (symlink|settings|absent)$/mu.exec(stdout);
  if (!marker) return "format";
  // A dotfiles symlink: replacing it over ssh would break the owner's setup, so nothing is written.
  if (marker[1] === "symlink") return "symlink";
  if (marker[1] === "absent") return { settings: {}, indent: "  ", present: false };
  const raw = stdout.slice(marker.index + marker[0].length + 1);
  try {
    const settings = JSON.parse(raw) as unknown;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return "settings";
    return { settings: settings as Settings, indent: /^[ \t]+(?=")/mu.exec(raw)?.[0] ?? "  ", present: true };
  } catch {
    // A file that does not parse is the owner's to fix: rewriting it would lose it.
    return "settings";
  }
}

async function putSettings(deps: RemoteHookDeps, alias: string, settings: Settings, indent: string): Promise<RemoteHookError | null> {
  const word = answerOf(await exec(deps, alias, REMOTE_PUT_SETTINGS_COMMAND, `${JSON.stringify(settings, null, indent)}\n`));
  return word === "ok" ? null : asError(word);
}

/**
 * Puts the hook script on the host and adds it to that host's
 * ~/.claude/settings.json. Call only from the owner's explicit action for this
 * host: it is the one place in Marshal that writes to another machine.
 */
export async function installRemoteHooks(
  host: RemoteHost,
  overrides: Partial<RemoteHookDeps> & { statePath: string }
): Promise<RemoteHookResult> {
  const deps = withDefaults(overrides);
  const state = readRemoteHookState(deps.statePath);
  let fresh = !(host.alias in state);
  try {
    const prepared = await prepare(deps, host.alias);
    const fail = async (error: RemoteHookError): Promise<RemoteHookResult> => {
      // A first install that did not finish leaves nothing behind on the host.
      if (fresh && error !== "symlink") await exec(deps, host.alias, REMOTE_REMOVE_COMMAND).catch(() => {});
      return { ok: false, error };
    };
    if (typeof prepared === "string") return await fail(prepared);
    // Hooks already in the file (state lost): removing the script would leave them dangling.
    if (JSON.stringify(removeRemoteHooks(prepared.settings)) !== JSON.stringify(prepared.settings)) fresh = false;
    // Script first: a hook that points at a missing script fails on every event.
    const put = answerOf(await exec(deps, host.alias, REMOTE_PUT_SCRIPT_COMMAND, REMOTE_HOOK_SCRIPT));
    if (put !== "ok") return await fail(asError(put));
    const error = await putSettings(deps, host.alias, addRemoteHooks(prepared.settings), prepared.indent);
    if (error) return await fail(error);
    writeRemoteHookState(deps.statePath, {
      ...state,
      [host.alias]: { hash: REMOTE_HOOK_SCRIPT_HASH, installedAt: deps.now() }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: classifyRemoteError(err) };
  }
}

/** Takes the hooks out of the host's settings.json, then removes the script, the spool and the local state. */
export async function uninstallRemoteHooks(
  alias: string,
  overrides: Partial<RemoteHookDeps> & { statePath: string }
): Promise<RemoteHookResult> {
  const deps = withDefaults(overrides);
  try {
    const prepared = await prepare(deps, alias);
    if (typeof prepared === "string") return { ok: false, error: prepared };
    const next = removeRemoteHooks(prepared.settings);
    if (JSON.stringify(next) !== JSON.stringify(prepared.settings)) {
      // Settings first: the script goes only once nothing points at it.
      const error = await putSettings(deps, alias, next, prepared.indent);
      if (error) return { ok: false, error };
    }
    if (answerOf(await exec(deps, alias, REMOTE_REMOVE_COMMAND)) !== "ok") return { ok: false, error: "format" };
    const { [alias]: _removed, ...rest } = readRemoteHookState(deps.statePath);
    writeRemoteHookState(deps.statePath, rest);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: classifyRemoteError(err) };
  }
}

export type RemoteHookEvent = { host: string; event: HookEvent; ageMs: number };

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/u;

/**
 * Events from the output of REMOTE_DRAIN_COMMAND. The spool is written on the
 * host, so every record is untrusted: one that does not parse, is older than
 * 15 minutes by the host's own clock or belongs to a folder outside the host's
 * allowed folders is dropped here.
 */
export function parseDrainOutput(host: RemoteHost, stdout: string): RemoteHookEvent[] {
  const lines = stdout.split("\n");
  let home: string | null = null;
  let now: number | null = null;
  const events: RemoteHookEvent[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("home ")) {
      const value = line.slice(5).trim();
      home = path.posix.isAbsolute(value) ? path.posix.normalize(value) : null;
    } else if (/^now \d+$/u.test(line)) {
      now = Number(line.slice(4));
    } else if (line === "event") {
      i += 1;
      if (now === null) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(lines[i] ?? "") as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof record !== "object" || record === null) continue;
      if (typeof record.s !== "string" || !SESSION_ID.test(record.s) || typeof record.t !== "number") continue;
      const ageMs = (now - record.t) * 1000;
      if (ageMs < 0 || ageMs > SPOOL_MAX_AGE_MS) continue;
      const event = parseHookPayload(
        JSON.stringify({ hook_event_name: record.e, session_id: record.s, cwd: record.c, notification_type: record.n })
      );
      if (!event || !isUnderRemoteRoots(event.cwd, resolveRoots(host.roots, home))) continue;
      events.push({ host: host.alias, event: { ...event, cwd: path.posix.normalize(event.cwd) }, ageMs });
    }
  }
  return events;
}

/** One exec, on demand, and only for a host whose hooks Marshal installed; otherwise no connection at all. */
export async function drainRemoteHookEvents(
  host: RemoteHost,
  overrides: Partial<RemoteHookDeps> & { statePath: string }
): Promise<{ events: RemoteHookEvent[]; error: RemoteError | null }> {
  const deps = withDefaults(overrides);
  if (!(host.alias in readRemoteHookState(deps.statePath))) return { events: [], error: null };
  try {
    return { events: parseDrainOutput(host, await exec(deps, host.alias, REMOTE_DRAIN_COMMAND)), error: null };
  } catch (err) {
    return { events: [], error: classifyRemoteError(err) };
  }
}
