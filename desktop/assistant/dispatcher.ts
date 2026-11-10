// Runs the voice dispatcher (#318): writes its folder, opens it and the
// `general` session in minimised Terminal windows, and answers its helper
// over the hook receiver. Started only when the assistant is on; between
// commands the one open stream is all that exists — no timers (#281).

import { execFile } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import type { ClaudeSession } from "../claude-code/registry.ts";
import type { AssistantRoutes } from "../claude-code/hook-service.ts";
import { readRecentTurns, type TranscriptTail } from "../claude-code/dossier.ts";
import { AssistantCommandQueue } from "./command-queue.ts";
import {
  buildGeneralPrompt,
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
  /** Runs one of Marshal's own features; returns what was said about it. */
  runAction: (action: string) => Promise<string>;
  /** Shown in the home line only: the owner's own command, echoed. */
  announce: (text: string) => void;
  focus: (pid: number) => void;
  runAppleScript?: (script: string) => Promise<void>;
  /** Where Claude Code keeps folder trust; ~/.claude.json. */
  claudeStatePath?: string;
};

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
  private readonly runAppleScript: (script: string) => Promise<void>;
  readonly dispatcherDir: string;
  private readonly assistantDir: string;

  constructor(private readonly deps: DispatcherDeps) {
    this.assistantDir = path.join(deps.userDataDir, "assistant");
    this.dispatcherDir = path.join(this.assistantDir, "dispatcher");
    this.runAppleScript = deps.runAppleScript ?? defaultRunAppleScript;
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
    const live = this.deps.liveSessions();
    if (!live.some((session) => this.isDispatcher(session))) {
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
    const dispatcher = this.deps.liveSessions().find((session) => this.isDispatcher(session));
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

  /** The owner turned the assistant off: the dispatcher goes, `general` may hold work and stays. */
  stop(): void {
    const dispatcher = this.deps.liveSessions().find((session) => this.isDispatcher(session));
    if (dispatcher) {
      try {
        process.kill(dispatcher.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }

  /** Whether this session event answers a voice command; a finished turn uses the claim up. */
  answersVoiceCommand(sessionId: string, finished: boolean): boolean {
    if (!this.awaitingAnswer.has(sessionId)) return false;
    if (finished) this.awaitingAnswer.delete(sessionId);
    return true;
  }

  /** A voice command from the home mic. Waits in the queue while the dispatcher is not listening. */
  submit(text: string): void {
    if (this.queue.submit(text)) {
      this.deps.announce(text);
      return;
    }
    const dispatcher = this.deps.liveSessions().find((session) => this.isDispatcher(session));
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
      return JSON.stringify(sessionsForDispatcher(this.deps.liveSessions(), this.dispatcherDir));
    }
    if (method === "GET" && route === "context") return this.deps.context();
    if (method !== "POST") return null;
    if (route === "say") {
      const text = args.join(" ");
      if (text) this.deps.say(text);
      return "ok";
    }
    if (route === "do") {
      const [action] = args;
      return action ? this.deps.runAction(action) : "usage: marshal do <action>";
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

    const before = this.deps.liveSessions();
    if (cwd === this.generalDir() && !rawName) {
      const general = before.find((session) => session.name === GENERAL_NAME);
      if (general) return `Ready: ${GENERAL_NAME}`;
      await this.openGeneral();
      return this.waitFor(new Set(before.map((s) => s.sessionId)), (s) => s.name === GENERAL_NAME);
    }

    const name = rawName?.trim().replace(/\s+/g, "-") || null;
    if (name && !isValidSessionName(name)) return "Invalid name: letters, digits, - and _ only, 40 at most.";
    if (name && before.some((session) => session.name === name)) return `A session named ${name} already exists.`;
    await this.open(cwd, sessionCommandLine(name), name ?? path.basename(cwd));
    return this.waitFor(
      new Set(before.map((s) => s.sessionId)),
      (s) => (name ? s.name === name : path.resolve(s.cwd) === path.resolve(cwd))
    );
  }

  private async waitFor(known: Set<string>, matches: (session: ClaudeSession) => boolean): Promise<string> {
    const deadline = Date.now() + SPAWN_WAIT_MS;
    while (Date.now() < deadline) {
      const fresh = this.deps.liveSessions().find((session) => !known.has(session.sessionId) && matches(session));
      if (fresh) return `Ready: ${fresh.name}`;
      await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_MS));
    }
    return "The terminal opened, but the session did not register in time. It may be waiting for an answer in its window.";
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

/** `./marshal peek <name>`: the session's last turns, for the dispatcher to retell in plain words. */
export function formatRecentTurns(tail: TranscriptTail | null): string {
  if (!tail || tail.turns.length === 0) return "No conversation yet.";
  const lines = tail.turns.slice(-6).map((turn) => `${turn.role === "user" ? "Owner" : "Claude"}: ${turn.text}`);
  return [tail.branch ? `Branch: ${tail.branch}` : "", ...lines].filter(Boolean).join("\n");
}
