// Read-only list of Claude Code sessions on other machines (#288, stage 1 of
// docs/REMOTE_SESSIONS.md). One `ssh` exec per allowed host, on demand only:
// no timer, no tunnel, nothing installed or changed on the host. Auth is the
// system ssh and its agent; Marshal never sees a key or a password.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { projectOf, type SessionGroup } from "../assistant/assistant-state.ts";
import { translate, type UiLanguage } from "../i18n/catalog.ts";
import { parseSessionFile, type SessionStatus } from "./registry.ts";

export type RemoteHost = {
  /** A Host alias from ~/.ssh/config. */
  alias: string;
  /** Folders on that host whose sessions may be listed: absolute, or `~/…` of the remote home. */
  roots: string[];
};

// Deliberately not a ClaudeSession: a remote pid or socket path means nothing
// on this Mac, and code that focuses or messages by pid must not accept one.
export type RemoteSession = {
  host: string;
  sessionId: string;
  /** `name@host`. */
  name: string;
  cwd: string;
  status: SessionStatus | null;
  waitingFor: string | null;
  updatedAt: number;
};

export type RemoteError = "timeout" | "host-key" | "auth" | "unreachable" | "format";

export type RemoteHostResult = { host: string; sessions: RemoteSession[]; error: RemoteError | null };

export const MAX_REMOTE_HOSTS = 8;
// An alias, never `user@host` or an address, and never something ssh could read as an option.
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const MAX_NAME_LENGTH = 80;

/**
 * One host per line: `alias: /abs/folder, ~/folder`. A line with a bad alias
 * or without a usable folder is dropped: a host with no folders lists nothing,
 * so keeping it would only cost a connection.
 */
export function parseRemoteHosts(text: string): RemoteHost[] {
  const hosts = new Map<string, RemoteHost>();
  for (const line of text.split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const alias = line.slice(0, colon).trim();
    if (!ALIAS.test(alias) || hosts.has(alias)) continue;
    const roots = line
      .slice(colon + 1)
      .split(",")
      .map((root) => root.trim())
      .filter((root) => root === "~" || root.startsWith("~/") || path.posix.isAbsolute(root));
    if (roots.length > 0) hosts.set(alias, { alias, roots });
    if (hosts.size === MAX_REMOTE_HOSTS) break;
  }
  return [...hosts.values()];
}

// Runs in the remote login shell, so it is a constant: nothing from settings or
// from a previous answer is ever spliced into it. Single quotes only around the
// whole script. Prints the remote home, then for every session file whose pid is
// alive and whose messaging socket exists: `file <pid>` and the JSON on one line.
export const REMOTE_LIST_COMMAND =
  "sh -c '" +
  'printf "home %s\\n" "$HOME"; ' +
  'for f in "$HOME"/.claude/sessions/*.json; do ' +
  '[ -f "$f" ] || continue; ' +
  'p=${f##*/}; p=${p%.json}; ' +
  'case $p in ""|*[!0-9]*) continue;; esac; ' +
  'kill -0 "$p" 2>/dev/null || continue; ' +
  's=$(sed -n "s/.*\\"messagingSocketPath\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p" "$f" | head -n 1); ' +
  '[ -S "$s" ] || continue; ' +
  'printf "file %s\\n" "$p"; tr -d "\\n\\r" < "$f"; printf "\\n"; ' +
  "done'";

/** argv for one read-only exec. Every option here closes something stage 1 must not do. */
export function sshArgs(alias: string): string[] {
  if (!ALIAS.test(alias)) throw new Error("invalid ssh host alias");
  return [
    "-n", // no stdin
    "-T", // no tty
    "-a", // no agent forwarding
    "-x", // no X11
    "-o", "BatchMode=yes", // never prompt: a key that needs a password is a failure
    "-o", "StrictHostKeyChecking=yes", // unknown or changed host key is an error, never auto-accepted
    "-o", "ClearAllForwardings=yes",
    "-o", "PermitLocalCommand=no",
    "-o", "ControlMaster=no", // reuse the owner's master if one is up, never leave one behind (#281)
    "-o", "ConnectTimeout=5",
    "-o", "LogLevel=ERROR",
    "--",
    alias,
    REMOTE_LIST_COMMAND
  ];
}

function isUnderRemoteRoots(cwd: string, roots: readonly string[]): boolean {
  if (!path.posix.isAbsolute(cwd)) return false;
  const dir = path.posix.normalize(cwd);
  return roots.some((root) => dir === root || dir.startsWith(root.endsWith("/") ? root : `${root}/`));
}

function resolveRoots(roots: readonly string[], home: string | null): string[] {
  return roots.flatMap((root) => {
    if (root !== "~" && !root.startsWith("~/")) return [path.posix.normalize(root)];
    return home ? [path.posix.join(home, root.slice(1))] : [];
  });
}

// What a remote host sends is untrusted: it ends up in a menu label and a window.
function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f@]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_NAME_LENGTH);
}

/**
 * Turn the output of REMOTE_LIST_COMMAND into sessions. Only sessions under
 * the host's allowed folders come out; the rest are dropped here, before
 * anything can show or log them.
 */
export function parseRemoteOutput(host: RemoteHost, stdout: string): RemoteHostResult {
  const lines = stdout.split("\n");
  let home: string | null = null;
  const sessions: RemoteSession[] = [];
  let sawHome = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("home ")) {
      sawHome = true;
      const value = line.slice(5).trim();
      home = path.posix.isAbsolute(value) ? path.posix.normalize(value) : null;
      continue;
    }
    const file = /^file (\d+)$/u.exec(line);
    if (!file) continue;
    const session = parseSessionFile(`${file[1]}.json`, lines[i + 1] ?? "");
    i += 1;
    if (!session) continue;
    if (!isUnderRemoteRoots(session.cwd, resolveRoots(host.roots, home))) continue;
    const name = cleanName(session.name) || path.posix.basename(session.cwd);
    sessions.push({
      host: host.alias,
      sessionId: session.sessionId,
      name: `${name}@${host.alias}`,
      cwd: path.posix.normalize(session.cwd),
      status: session.status,
      waitingFor: session.waitingFor ? cleanName(session.waitingFor) : null,
      updatedAt: session.statusUpdatedAt ?? session.startedAt
    });
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  // No `home` line: a login banner, another shell, or not our script at all.
  return { host: host.alias, sessions, error: sawHome ? null : "format" };
}

export function classifyRemoteError(err: unknown): RemoteError {
  const e = err as { killed?: boolean; code?: unknown; stderr?: unknown };
  if (e.killed === true || e.code === "ETIMEDOUT") return "timeout";
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  if (/host key verification failed|host identification has changed|no .* host key is known/iu.test(stderr)) {
    return "host-key";
  }
  if (/permission denied|too many authentication failures/iu.test(stderr)) return "auth";
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "format";
  return "unreachable";
}

export type SshExec = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number }
) => Promise<{ stdout: string; stderr: string }>;

export type RemoteDeps = { exec: SshExec; sshPath: string; warn: (message: string) => void; now: () => number };

const EXEC_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const CACHE_MS = 5 * 60_000;

const defaultDeps: RemoteDeps = {
  exec: promisify(execFile) as SshExec,
  // Absolute, so a `ssh` earlier on PATH is never picked up.
  sshPath: "/usr/bin/ssh",
  warn: (message) => console.warn(`[remote-sessions] ${message}`),
  now: () => Date.now()
};

export async function listRemoteSessions(host: RemoteHost, overrides: Partial<RemoteDeps> = {}): Promise<RemoteHostResult> {
  const deps = { ...defaultDeps, ...overrides };
  try {
    const { stdout } = await deps.exec(deps.sshPath, sshArgs(host.alias), {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES
    });
    return parseRemoteOutput(host, stdout);
  } catch (err) {
    return { host: host.alias, sessions: [], error: classifyRemoteError(err) };
  }
}

/**
 * The last answer of every allowed host. `refresh()` runs only when a window
 * or the tray menu asks; between asks nothing is open and nothing ticks (#281).
 */
export class RemoteSessionList {
  private results: RemoteHostResult[] = [];
  private fetchedAt = 0;
  private fetchedFor = "";
  private inFlight: Promise<void> | null = null;
  private readonly hosts: () => RemoteHost[];
  private readonly deps: Partial<RemoteDeps>;

  constructor(hosts: () => RemoteHost[], deps: Partial<RemoteDeps> = {}) {
    this.hosts = hosts;
    this.deps = deps;
  }

  /** Resolves once every host answered or failed; concurrent calls share one round. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const hosts = this.hosts();
    if (hosts.length === 0) {
      this.results = [];
      return Promise.resolve();
    }
    const key = JSON.stringify(hosts);
    this.inFlight = Promise.all(hosts.map((host) => listRemoteSessions(host, this.deps)))
      .then((results) => {
        this.results = results;
        this.fetchedFor = key;
        this.fetchedAt = (this.deps.now ?? defaultDeps.now)();
        const failed = results.filter((result) => result.error);
        if (failed.length > 0) {
          // Kinds only: host names and paths stay out of the log.
          (this.deps.warn ?? defaultDeps.warn)(
            `${failed.length} of ${results.length} host(s) did not answer: ${failed.map((r) => r.error).join(", ")}`
          );
        }
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Empty once the allowlist changed or the answer is older than five minutes: stale state is worse than none. */
  current(): RemoteHostResult[] {
    const now = (this.deps.now ?? defaultDeps.now)();
    if (now - this.fetchedAt > CACHE_MS) return [];
    return JSON.stringify(this.hosts()) === this.fetchedFor ? this.results : [];
  }
}

/** Groups for the home sessions panel: `project · remote host`, sessions marked `remote`, pid 0 (not focusable). */
export function remoteGroups(results: readonly RemoteHostResult[], lang: UiLanguage = "en"): SessionGroup[] {
  return results.flatMap((result) => {
    if (result.error) {
      return [{ project: `${result.host} · ${translate(lang, `remote.error.${result.error}`)}`, sessions: [] }];
    }
    const groups = new Map<string, SessionGroup>();
    for (const session of result.sessions) {
      const project = `${projectOf(session.cwd)} · ${translate(lang, "remote.host", { host: result.host })}`;
      const group = groups.get(project) ?? { project, sessions: [] };
      group.sessions.push({
        pid: 0,
        name: session.name,
        status: session.status,
        waitingFor: session.waitingFor,
        remote: true
      });
      groups.set(project, group);
    }
    return [...groups.values()];
  });
}
