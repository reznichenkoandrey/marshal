// Runs the voice dispatcher (#318): writes its folder, opens it and the
// `general` session in minimised Terminal windows, and answers its helper
// over the hook receiver. Started only when the assistant is on; between
// commands the one open stream is all that exists — no timers (#281).

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import type { ClaudeSession } from "../claude-code/registry.ts";
import type { AssistantRoutes } from "../claude-code/hook-service.ts";
import { readRecentTurns, type TranscriptTail } from "../claude-code/dossier.ts";
import { replyRefusal } from "../claude-code/reply.ts";
import { AssistantCommandQueue } from "./command-queue.ts";
import type { CommandRoute } from "./command-log.ts";
import {
  buildGeneralPrompt,
  findNamedClaudePids,
  buildHelperScript,
  dispatcherCommandLine,
  DISPATCHER_NAME,
  DISPATCHER_PROMPT,
  DISPATCHER_SETTINGS,
  findProject,
  GENERAL_NAME,
  generalCommandLine,
  HELPER_NAME,
  isDispatcherSession,
  isValidSessionName,
  parseHelperArgs,
  sessionCommandLine,
  sessionsForDispatcher,
  spawnProjects,
  terminalScript,
  unminimiseTerminalScript,
  withTrustedFolder,
  type GeneralPermissionMode
} from "./dispatcher-files.ts";

const SPAWN_WAIT_MS = 45_000;
const SPAWN_POLL_MS = 1_000;
// A session opened this recently is still starting, not stuck on a prompt.
const STARTING_MS = 60_000;
// Within two minutes of the last answer a command without a name continues that conversation.
const FOLLOW_UP_MS = 2 * 60_000;
const DEFAULT_SESSION_IDLE_MIN = 30;

/**
 * How long a session opened by `./marshal spawn` may sit idle before it is
 * closed (#388); `MARSHAL_ASSISTANT_SESSION_IDLE_MIN`, 0 = never.
 */
export function sessionIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARSHAL_ASSISTANT_SESSION_IDLE_MIN?.trim();
  const minutes = raw ? Number(raw) : DEFAULT_SESSION_IDLE_MIN;
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
}

/**
 * Marshal's own sessions the registry misses: a session that inherited a
 * Claude host's environment writes no registry file (#388). Found by argv,
 * addressed by the socket Claude Code opens for every pid.
 */
export function unregisteredOwnSessions(
  registered: readonly ClaudeSession[],
  running: ReadonlyArray<{ name: string; cwd: string; pids: readonly number[] }>,
  socketExists: (socketPath: string) => boolean
): ClaudeSession[] {
  const known = new Set(registered.map((session) => session.pid));
  return running.flatMap(({ name, cwd, pids }) => pids
    .filter((pid) => !known.has(pid))
    .map((pid) => ({ pid, socketPath: path.join(SOCKETS_DIR, `${pid}.sock`) }))
    .filter(({ socketPath }) => socketExists(socketPath))
    .map(({ pid, socketPath }): ClaudeSession => ({
      pid,
      sessionId: `pid:${pid}`,
      name,
      cwd,
      status: null,
      waitingFor: null,
      entrypoint: "cli",
      socketPath,
      startedAt: 0,
      statusUpdatedAt: null
    })));
}

// Where Claude Code opens a session's messaging socket (`messagingSocketPath` in the registry).
const SOCKETS_DIR = "/tmp/cc-socks";

export type DispatcherSettings = {
  model: string;
  /** Empty = Marshal's own folder in userData. */
  generalDir: string;
  generalMode: GeneralPermissionMode;
  routingRoots: string[];
};

export type DispatcherDeps = {
  userDataDir: string;
  hookDir: () => string;
  settings: () => DispatcherSettings;
  liveSessions: () => ClaudeSession[];
  /** `./marshal context`: "off", or the routable sessions with their dossiers. */
  context: () => Promise<string>;
  /** Spoken and shown in the home line. */
  say: (text: string) => void;
  /** Speaks a question and listens for the reply without a key (#375); null when nobody answered. */
  ask: (question: string) => Promise<string | null>;
  /** Runs one of Marshal's own features; returns what was said about it. */
  runAction: (action: string) => Promise<string>;
  /** Shown in the home line only: the owner's own command, echoed. */
  announce: (text: string) => void;
  focus: (pid: number) => void;
  /** `./marshal insert`: types the text into the app the owner was in when they spoke (#361). */
  insert: (text: string) => Promise<string>;
  /** `./marshal reply`: types the owner's words into the session as their own input (#394). */
  reply: (session: ClaudeSession, text: string) => Promise<string>;
  runAppleScript?: (script: string) => Promise<void>;
  /** Where Claude Code keeps folder trust; ~/.claude.json. */
  claudeStatePath?: string;
  /** `ps -axo pid=,command=` (`listProcesses`), read only when a session of Marshal's own is looked up; absent = registry only. */
  processList?: () => string;
  socketExists?: (socketPath: string) => boolean;
  kill?: (pid: number) => void;
  /** 0 = spawned sessions stay until closed by hand. */
  sessionIdleMs?: number;
  log?: (message: string) => void;
  /** Voice command log for the home dashboard (#398): each command, and where it went. */
  commands?: { add: (text: string) => void; route: (route: CommandRoute) => void };
};

/** `ps -axo pid=,command=`; empty on failure, so the registry alone decides. */
export function listProcesses(): string {
  try {
    return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return "";
  }
}

function defaultKill(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

function defaultRunAppleScript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (err) => (err ? reject(err) : resolve()));
  });
}

export class AssistantDispatcher implements AssistantRoutes {
  private readonly queue = new AssistantCommandQueue();
  private readonly launchedAt = new Map<string, number>();
  /** Sessions holding an owner's voice command: only their answers are spoken. */
  private readonly awaitingAnswer = new Set<string>();
  /** Where the last voice command went; a command soon after it continues that conversation (#412). */
  private previous: { target: string; sessionId?: string; at: number } | null = null;
  /** Sessions `./marshal spawn` opened, by session id: the idle timer that closes them. */
  private readonly spawned = new Map<string, NodeJS.Timeout | null>();
  private readonly runAppleScript: (script: string) => Promise<void>;
  private readonly kill: (pid: number) => void;
  private readonly idleMs: number;
  readonly dispatcherDir: string;
  private readonly assistantDir: string;

  constructor(private readonly deps: DispatcherDeps) {
    this.assistantDir = path.join(deps.userDataDir, "assistant");
    this.dispatcherDir = path.join(this.assistantDir, "dispatcher");
    this.runAppleScript = deps.runAppleScript ?? defaultRunAppleScript;
    this.kill = deps.kill ?? defaultKill;
    this.idleMs = deps.sessionIdleMs ?? sessionIdleMs();
  }

  /** The registry plus the dispatcher and `general` processes it does not list. */
  private liveSessions(): ClaudeSession[] {
    const registered = this.deps.liveSessions();
    const psOutput = this.deps.processList?.() ?? "";
    const running = [
      { name: DISPATCHER_NAME, cwd: this.dispatcherDir, pids: findNamedClaudePids(psOutput, DISPATCHER_NAME) },
      { name: GENERAL_NAME, cwd: this.generalDir(), pids: findNamedClaudePids(psOutput, GENERAL_NAME) }
    ];
    const extra = unregisteredOwnSessions(registered, running, this.deps.socketExists ?? fs.existsSync);
    if (extra.length > 0) this.deps.log?.(`[assistant] ${extra.length} own session(s) missing from the registry: ${extra.map((s) => `${s.name}#${s.pid}`).join(", ")}`);
    return [...registered, ...extra];
  }

  private dispatchers(live: readonly ClaudeSession[] = this.liveSessions()): ClaudeSession[] {
    return live.filter((session) => this.isDispatcher(session) || session.name === DISPATCHER_NAME);
  }

  get listening(): boolean {
    return this.queue.listening;
  }

  private get helperPath(): string {
    return path.join(this.dispatcherDir, HELPER_NAME);
  }

  private get generalPromptPath(): string {
    return path.join(this.assistantDir, "general-prompt.md");
  }

  generalDir(): string {
    return this.deps.settings().generalDir || path.join(this.assistantDir, GENERAL_NAME);
  }

  isDispatcher(session: Pick<ClaudeSession, "cwd">): boolean {
    return isDispatcherSession(session, this.dispatcherDir);
  }

  /** Opens whatever of the dispatcher and `general` is not running yet. */
  async start(): Promise<void> {
    await this.launch().catch((err: unknown) => this.deps.say(this.launchError(err)));
  }

  private async launch(): Promise<void> {
    this.writeFiles();
    const live = this.liveSessions();
    const dispatchers = this.dispatchers(live);
    // One dispatcher: a second one would read the same command stream.
    for (const extra of dispatchers.slice(1)) this.kill(extra.pid);
    if (dispatchers.length === 0) {
      this.trust(this.dispatcherDir);
      await this.open(this.dispatcherDir, dispatcherCommandLine(this.deps.settings().model, this.deps.settings().generalMode), DISPATCHER_NAME);
    }
    if (!live.some((session) => session.name === GENERAL_NAME)) await this.openGeneral();
  }

  /**
   * The dock's "assistant terminal" (#340): the running dispatcher's Terminal
   * tab comes forward un-minimised; a missing one is opened in plain sight.
   */
  async reveal(): Promise<void> {
    const dispatcher = this.dispatchers()[0];
    if (dispatcher) {
      this.deps.focus(dispatcher.pid);
      return;
    }
    if (Date.now() - (this.launchedAt.get(DISPATCHER_NAME) ?? 0) < STARTING_MS) {
      // Opened minimised a moment ago and not registered yet: its tab still carries the title.
      await this.runAppleScript(unminimiseTerminalScript(DISPATCHER_NAME));
      return;
    }
    this.writeFiles();
    this.trust(this.dispatcherDir);
    const { model, generalMode } = this.deps.settings();
    await this.open(this.dispatcherDir, dispatcherCommandLine(model, generalMode), DISPATCHER_NAME, false);
  }

  /** The owner turned the assistant off or quit Marshal: the dispatcher goes, `general` may hold work and stays. */
  stop(): void {
    for (const dispatcher of this.dispatchers()) this.kill(dispatcher.pid);
    for (const timer of this.spawned.values()) if (timer) clearTimeout(timer);
    this.spawned.clear();
  }

  /**
   * A hook event from any session. A spawned session's idle clock restarts on
   * every finished turn and stops while it works or waits for the owner.
   */
  noteSessionEvent(sessionId: string, kind: "finished" | "waiting"): void {
    if (!this.spawned.has(sessionId)) return;
    const timer = this.spawned.get(sessionId);
    if (timer) clearTimeout(timer);
    this.spawned.set(sessionId, kind === "finished" ? this.armIdle(sessionId) : null);
  }

  private armIdle(sessionId: string): NodeJS.Timeout | null {
    if (this.idleMs <= 0) return null;
    const timer = setTimeout(() => this.closeIfIdle(sessionId), this.idleMs);
    timer.unref?.();
    return timer;
  }

  private closeIfIdle(sessionId: string): void {
    this.spawned.set(sessionId, null);
    const session = this.deps.liveSessions().find((live) => live.sessionId === sessionId);
    if (!session) {
      this.spawned.delete(sessionId);
      return;
    }
    // A voice command is on its way: its answer restarts the clock.
    if (this.awaitingAnswer.has(sessionId)) {
      this.spawned.set(sessionId, this.armIdle(sessionId));
      return;
    }
    // Working or waiting for the owner: the next finished turn restarts the clock.
    if (session.status !== "idle") return;
    this.spawned.delete(sessionId);
    this.deps.log?.(`[assistant] closing ${session.name}#${session.pid}: idle for ${Math.round(this.idleMs / 60_000)} min`);
    this.kill(session.pid);
  }

  /** Whether this session event answers a voice command; a finished turn uses the claim up. */
  answersVoiceCommand(sessionId: string, finished: boolean): boolean {
    if (!this.awaitingAnswer.has(sessionId)) return false;
    if (finished) this.awaitingAnswer.delete(sessionId);
    // The conversation goes on from the answer, not from when the command was sent.
    if (finished && this.previous?.sessionId === sessionId) this.previous.at = Date.now();
    return true;
  }

  private notePrevious(target: string, sessionId?: string): void {
    this.previous = { target, sessionId, at: Date.now() };
  }

  /** A voice command from the home mic. Waits in the queue while the dispatcher is not listening. */
  submit(text: string): void {
    this.deps.commands?.add(text);
    const previous = this.previous && Date.now() - this.previous.at <= FOLLOW_UP_MS ? this.previous.target : undefined;
    if (this.queue.submit(text, { previous })) {
      this.deps.announce(text);
      return;
    }
    const dispatcher = this.dispatchers()[0];
    if (!dispatcher) {
      this.deps.say("Запускаю асистента, команда дочекається.");
      void this.start();
      return;
    }
    if (Date.now() - (this.launchedAt.get(DISPATCHER_NAME) ?? 0) < STARTING_MS) {
      this.deps.say("Асистент ще запускається, команда дочекається.");
      return;
    }
    // Alive without its monitor: stopped at a prompt in its Terminal window.
    this.deps.say(`Диспетчер чекає на відповідь у вікні Terminal «${DISPATCHER_NAME}».`);
    this.deps.focus(dispatcher.pid);
  }

  respond(method: string, route: string, body: string, res: http.ServerResponse): void {
    if (method === "GET" && route === "commands") {
      this.stream(res);
      return;
    }
    void this.answer(method, route, parseHelperArgs(body))
      .then((reply) => {
        if (reply === null) res.writeHead(404).end();
        else res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(reply.endsWith("\n") ? reply : `${reply}\n`);
      })
      .catch((err: unknown) => {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(`${err instanceof Error ? err.message : String(err)}\n`);
      });
  }

  private stream(res: http.ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
    res.flushHeaders();
    const sink = { write: (line: string) => res.write(line) };
    res.on("close", () => this.queue.disconnect(sink));
    this.queue.connect(sink);
  }

  private async answer(method: string, route: string, args: string[]): Promise<string | null> {
    if (method === "GET" && route === "sessions") {
      return JSON.stringify(sessionsForDispatcher(this.liveSessions(), this.dispatcherDir));
    }
    if (method === "GET" && route === "context") return this.deps.context();
    if (method !== "POST") return null;
    if (route === "say") {
      const text = args.join(" ");
      if (text) this.deps.say(text);
      if (text) this.deps.commands?.route({ kind: "general", target: "marshal", outcome: "answered" });
      if (text) this.notePrevious(DISPATCHER_NAME);
      return "ok";
    }
    if (route === "ask") {
      const question = args.join(" ");
      if (!question) return "usage: marshal ask <question>";
      return (await this.deps.ask(question)) ?? "(no answer)";
    }
    if (route === "do") {
      // Most actions are one word; `hub-login` takes the spoken profile too (#419).
      const action = args.join(" ");
      if (!action) return "usage: marshal do <action> [words]";
      const said = await this.deps.runAction(action).catch((err: unknown) => {
        this.deps.commands?.route({ kind: "feature", target: action, outcome: "failed" });
        throw err;
      });
      this.deps.commands?.route({ kind: "feature", target: action, outcome: "answered" });
      this.notePrevious(DISPATCHER_NAME);
      return said;
    }
    if (route === "insert") {
      const text = args.join(" ");
      return text ? this.deps.insert(text) : "usage: marshal insert <text>";
    }
    if (route === "reply") {
      const [name, ...words] = args;
      const text = words.join(" ");
      if (!name || !text) return "usage: marshal reply <session> <owner's words>";
      const target = this.deps.liveSessions().find((session) => session.name === name);
      const refusal = replyRefusal(target, name);
      if (!target || refusal) return refusal;
      const result = await this.deps.reply(target, text);
      this.deps.commands?.route({ kind: "session", target: name, outcome: result === "ok" ? "sent" : "failed" });
      // The session's answer is what the owner waits to hear.
      if (result === "ok") this.awaitingAnswer.add(target.sessionId);
      if (result === "ok") this.notePrevious(name, target.sessionId);
      return result;
    }
    if (route === "spawn") return this.spawn(args);
    if (route === "peek") {
      const target = this.deps.liveSessions().find((session) => session.name === args.join(" "));
      if (!target) return `No live session named "${args.join(" ")}".`;
      return formatRecentTurns(readRecentTurns(target));
    }
    if (route === "sent") {
      const target = this.deps.liveSessions().find((session) => session.name === args.join(" "));
      if (!target) return `No live session named "${args.join(" ")}".`;
      this.awaitingAnswer.add(target.sessionId);
      this.deps.commands?.route({ kind: "session", target: target.name ?? args.join(" "), outcome: "sent" });
      this.notePrevious(target.name ?? args.join(" "), target.sessionId);
      return "ok";
    }
    return null;
  }

  private async spawn(args: string[]): Promise<string> {
    const { routingRoots } = this.deps.settings();
    const projects = spawnProjects(this.deps.liveSessions(), listChildFolders(routingRoots), this.generalDir());
    if (args.length === 0) return `Projects: ${[...projects.keys()].join(", ")}`;

    const [wanted, rawName] = args;
    const cwd = findProject(projects, wanted);
    if (!cwd) return `Unknown project "${wanted}". Known: ${[...projects.keys()].join(", ")}`;

    const before = this.liveSessions();
    if (cwd === this.generalDir() && !rawName) {
      const general = before.find((session) => session.name === GENERAL_NAME);
      if (general) return `Ready: ${GENERAL_NAME}`;
      await this.openGeneral();
      return describeSpawn(await this.waitFor(new Set(before.map((s) => s.sessionId)), (s) => s.name === GENERAL_NAME));
    }

    const name = rawName?.trim().replace(/\s+/g, "-") || null;
    if (name && !isValidSessionName(name)) return "Invalid name: letters, digits, - and _ only, 40 at most.";
    if (name && before.some((session) => session.name === name)) return `A session named ${name} already exists.`;
    await this.open(cwd, sessionCommandLine(name), name ?? path.basename(cwd));
    const fresh = await this.waitFor(
      new Set(before.map((s) => s.sessionId)),
      (s) => (name ? s.name === name : path.resolve(s.cwd) === path.resolve(cwd))
    );
    if (fresh) this.spawned.set(fresh.sessionId, this.armIdle(fresh.sessionId));
    return describeSpawn(fresh);
  }

  private async waitFor(known: Set<string>, matches: (session: ClaudeSession) => boolean): Promise<ClaudeSession | null> {
    const deadline = Date.now() + SPAWN_WAIT_MS;
    while (Date.now() < deadline) {
      const fresh = this.deps.liveSessions().find((session) => !known.has(session.sessionId) && matches(session));
      if (fresh) return fresh;
      await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_MS));
    }
    return null;
  }

  private async openGeneral(): Promise<void> {
    const dir = this.generalDir();
    fs.mkdirSync(dir, { recursive: true });
    this.trust(dir);
    await this.open(dir, generalCommandLine(this.generalPromptPath, this.deps.settings().generalMode), GENERAL_NAME);
  }

  private async open(cwd: string, commandLine: string, title: string, minimised = true): Promise<void> {
    // A second window for the same session while the first is still starting.
    if (Date.now() - (this.launchedAt.get(title) ?? 0) < STARTING_MS) return;
    this.launchedAt.set(title, Date.now());
    try {
      await this.runAppleScript(terminalScript(cwd, commandLine, title, minimised));
    } catch (err) {
      this.launchedAt.delete(title);
      throw err;
    }
  }

  private launchError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return /-1743|not authori[sz]ed/i.test(message)
      ? "Marshal не може відкрити Terminal: дозволь у System Settings → Privacy & Security → Automation."
      : `Не вдалося запустити асистента: ${message}`;
  }

  private writeFiles(): void {
    fs.mkdirSync(path.join(this.dispatcherDir, ".claude"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.dispatcherDir, "CLAUDE.md"), DISPATCHER_PROMPT);
    fs.writeFileSync(path.join(this.dispatcherDir, ".claude", "settings.json"), `${JSON.stringify(DISPATCHER_SETTINGS, null, 2)}\n`);
    fs.writeFileSync(this.helperPath, buildHelperScript(this.deps.hookDir()), { mode: 0o700 });
    fs.chmodSync(this.helperPath, 0o700);
    fs.writeFileSync(this.generalPromptPath, buildGeneralPrompt(this.helperPath));
  }

  /** Marks the folder trusted in ~/.claude.json, once, with an atomic replace. */
  private trust(dir: string): void {
    const file = this.deps.claudeStatePath ?? path.join(os.homedir(), ".claude.json");
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (err) {
      // A file Claude Code is halfway through writing is not ours to replace.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    const next = withTrustedFolder(state, dir);
    if (!next) return;
    const tmp = `${file}.marshal-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

function listChildFolders(roots: readonly string[]): string[] {
  return roots.flatMap((root) => {
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => path.join(root, entry.name));
    } catch {
      return [];
    }
  });
}

function describeSpawn(session: ClaudeSession | null): string {
  return session
    ? `Ready: ${session.name}`
    : "The terminal opened, but the session did not register in time. It may be waiting for an answer in its window.";
}

/** `./marshal peek <name>`: the session's last turns, for the dispatcher to retell in plain words. */
export function formatRecentTurns(tail: TranscriptTail | null): string {
  if (!tail || tail.turns.length === 0) return "No conversation yet.";
  const lines = tail.turns.slice(-6).map((turn) => `${turn.role === "user" ? "Owner" : "Claude"}: ${turn.text}`);
  return [tail.branch ? `Branch: ${tail.branch}` : "", ...lines].filter(Boolean).join("\n");
}
