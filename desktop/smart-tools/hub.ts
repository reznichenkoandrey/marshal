// desktop/smart-tools/hub.ts
//
// Bridge to `smart-hub`, a loopback HTTP server from a separate personal CLI
// toolchain (installed outside this repo, symlinked into ~/.local/bin). It
// serves an HTML panel for browser profiles, their logins, tracker tasks and
// worktree state; the panel is styled from Marshal's design tokens so it reads
// as one of Marshal's windows (#416).
//
// Marshal owns the lifecycle and nothing else. It starts the binary, reads the
// port and the token the server writes, and hands both to the window. Every
// pixel and every byte of data inside that window comes from the hub at
// runtime: no panel markup, no profile names and no passwords live here. The
// hub owns the Keychain path.
//
// Honesty about state is the point. A missing binary and a server that is not
// running are two different answers, and neither is an empty panel.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Binaries of the toolchain, looked up on PATH — main already adds ~/.local/bin (#349). */
export const HUB_BIN = "smart-hub";
export const TRACKER_BIN = "smart-plane";
export const BROWSER_BIN = "smart-browser";

/** Every /api/* request carries the token in this header. `GET /` serves the panel. */
export const TOKEN_HEADER = "X-Smart-Hub-Token";

const START_TIMEOUT_MS = 20_000;
const START_POLL_MS = 200;
const PROBE_TIMEOUT_MS = 1_500;

export type HubState =
  | { kind: "missing" }
  | { kind: "stopped" }
  | { kind: "running"; url: string; token: string };

export type HubCredentials = { port: number; token: string };

/** A browser profile as the hub reports it. `id` is the argument the login CLI takes. */
export type HubProfile = { id: string; parts: string[] };

export type HubWindowState = { width: number; height: number; x: number | null; y: number | null };

export function hubUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function parsePort(text: string): number | null {
  const port = Number.parseInt(text.trim(), 10);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/**
 * The port and token files are written 0600. A token any process on the Mac can
 * read is not a secret, so a wider mode is a refusal, not a warning.
 */
export function isPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

export function findOnPath(
  name: string,
  pathEnv: string,
  isExecutable: (file: string) => boolean = canExecute
): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function canExecute(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Profiles out of `GET /api/state`. The shape is the hub's to define, so this
 * reads both forms it can reasonably take — a `project/env/role` string or an
 * object with those fields — and ignores anything it cannot turn into a login
 * argument. Marshal holds no profile names of its own.
 */
export function readProfiles(state: unknown): HubProfile[] {
  const list = (state as { profiles?: unknown } | null)?.profiles;
  if (!Array.isArray(list)) return [];
  const out: HubProfile[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const id = profileId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, parts: id.split("/").filter(Boolean) });
  }
  return out;
}

function profileId(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim() || null;
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const direct = ["id", "profile", "name"].map((key) => record[key]).find((value) => typeof value === "string");
  if (typeof direct === "string" && direct.includes("/")) return direct.trim() || null;
  const parts = ["project", "env", "role"].map((key) => record[key]);
  if (parts.every((value) => typeof value === "string" && value.trim())) {
    return parts.map((value) => (value as string).trim()).join("/");
  }
  return typeof direct === "string" ? direct.trim() || null : null;
}

/**
 * Match what the owner said against the hub's own profile list. Scored by how
 * much of a profile the utterance actually names, so a bare "dev" that fits
 * several profiles stays unresolved and the assistant says so instead of
 * logging into the wrong one.
 */
export function pickProfile(spoken: string, profiles: HubProfile[]): HubProfile | null {
  const words = new Set(normalizeWords(spoken));
  let best: HubProfile | null = null;
  let bestScore = 0;
  let tied = false;
  for (const profile of profiles) {
    let score = 0;
    for (const part of profile.parts) {
      const tokens = normalizeWords(part);
      if (tokens.length > 0 && tokens.every((token) => words.has(token))) {
        score += part.length;
      }
    }
    if (score === 0) continue;
    if (score > bestScore) {
      best = profile;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function clampWindowState(parsed: unknown, defaults: HubWindowState, min: { width: number; height: number }): HubWindowState {
  const input = (parsed ?? {}) as Partial<HubWindowState>;
  const size = (value: unknown, fallback: number, floor: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= floor ? Math.round(value) : fallback;
  return {
    width: size(input.width, defaults.width, min.width),
    height: size(input.height, defaults.height, min.height),
    x: Number.isFinite(input.x) ? Math.round(input.x as number) : null,
    y: Number.isFinite(input.y) ? Math.round(input.y as number) : null
  };
}

export class SmartHubService {
  private readonly dir: string;
  private readonly pathEnv: string;
  private child: ChildProcess | null = null;
  private starting: Promise<HubState> | null = null;

  constructor(options: { dir?: string; pathEnv?: string } = {}) {
    this.dir = options.dir ?? path.join(os.homedir(), ".claude", "smart-hub");
    this.pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  }

  /** Where the binary is, or null when the toolchain is not installed here. */
  locate(binary: string = HUB_BIN): string | null {
    return findOnPath(binary, this.pathEnv);
  }

  /**
   * The port/token pair the running server wrote, or null when either file is
   * absent, malformed or readable by more than its owner.
   */
  credentials(): HubCredentials | null {
    const port = this.readPrivateFile("port");
    const token = this.readPrivateFile("token");
    if (!port || !token) return null;
    const parsed = parsePort(port);
    return parsed ? { port: parsed, token: token.trim() } : null;
  }

  /**
   * Hands back a URL and a token, starting the server if nothing answers. Reuses
   * a server that is already up — the toolchain's own CLIs start it too.
   */
  async ensure(): Promise<HubState> {
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Parsed `GET /api/state` of a running hub, or null when it stopped answering. */
  async stateOf(hub: Extract<HubState, { kind: "running" }>): Promise<unknown | null> {
    return this.fetchState(hub.url, hub.token);
  }

  /**
   * Logs a profile in through the toolchain's browser CLI. It reads the password
   * from the Keychain itself: no password ever passes through Marshal. Detached,
   * because a login outlives the click that started it.
   */
  login(profile: HubProfile): boolean {
    const bin = this.locate(BROWSER_BIN);
    if (!bin) return false;
    try {
      const child = spawn(bin, ["login", profile.id], {
        stdio: "ignore",
        detached: true
      });
      child.on("error", (err) => console.warn("[smart-hub] login failed to start:", err.message));
      child.unref();
      return true;
    } catch (err) {
      console.warn("[smart-hub] login failed to start:", (err as Error).message);
      return false;
    }
  }

  /** Only ever kills a server this process started, so quitting leaves no orphan. */
  stop(): void {
    if (!this.child || this.child.exitCode !== null) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    this.child = null;
  }

  private async start(): Promise<HubState> {
    const bin = this.locate();
    if (!bin) return { kind: "missing" };

    const existing = this.credentials();
    if (existing && (await this.fetchState(hubUrl(existing.port), existing.token)) !== null) {
      return { kind: "running", url: hubUrl(existing.port), token: existing.token };
    }

    this.spawnServer(bin);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(START_POLL_MS);
      const cred = this.credentials();
      if (cred && (await this.fetchState(hubUrl(cred.port), cred.token)) !== null) {
        // The tracker's cached task list is 5.05 s cold and 0.30 s warm — pay it
        // now, before anybody looks at the panel (#418).
        this.warmTracker();
        return { kind: "running", url: hubUrl(cred.port), token: cred.token };
      }
      // The process died (or never started): no point waiting out the deadline.
      if (!this.child || this.child.exitCode !== null) break;
    }
    return { kind: "stopped" };
  }

  private spawnServer(bin: string): void {
    if (this.child && this.child.exitCode === null) return;
    try {
      this.child = spawn(bin, ["serve"], {
        stdio: "ignore",
        detached: false
      });
      this.child.on("error", (err) => console.warn("[smart-hub] serve failed to start:", err.message));
      this.child.on("exit", () => {
        this.child = null;
      });
      // The server idles out by itself; Marshal does not keep it alive.
      this.child.unref();
    } catch (err) {
      console.warn("[smart-hub] serve failed to start:", (err as Error).message);
      this.child = null;
    }
  }

  /** Fire and forget: the binary may be absent, and a cold cache is not an error. */
  private warmTracker(): void {
    const bin = this.locate(TRACKER_BIN);
    if (!bin) return;
    try {
      const child = spawn(bin, ["mine"], {
        stdio: "ignore",
        detached: true
      });
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // Swallowed on purpose: nobody is waiting on this.
    }
  }

  private async fetchState(url: string, token: string): Promise<unknown | null> {
    try {
      const response = await fetch(`${url}/api/state`, {
        headers: { [TOKEN_HEADER]: token },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  private readPrivateFile(name: string): string | null {
    const file = path.join(this.dir, name);
    try {
      const stat = fs.statSync(file);
      if (!isPrivateMode(stat.mode)) {
        console.warn(`[smart-hub] ignoring ${name}: file is readable by more than its owner`);
        return null;
      }
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
