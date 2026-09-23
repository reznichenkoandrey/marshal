// desktop/dictation/whisper-server.ts
//
// A resident whisper.cpp process (#218). `whisper-cli` loads the 1.5 GB model
// and initialises Metal on every call, and on an M3 Pro that is nearly all of
// its 1.6 s per utterance — a 3 s clip costs the same as a 9 s one. Kept
// resident in `whisper-server`, the same model answers in ~0.6-0.7 s, and
// because the server serialises requests behind one mutex, a live partial and
// a final no longer load two copies of the model and fight over the GPU
// (#219: a final went from 1.6 s to 4.7-11.3 s that way).
//
// One process for the whole app, started on first use and stopped after
// IDLE_STOP_MS without a request, so 1.5 GB is not held while neither
// captions nor dictation is in use. Anything that stops the server from
// working falls back to `whisper-cli` — slower, never broken.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";

import { LANGUAGES } from "../translator/languages.ts";
import type { TranscribeOptions, TranscribeResult, WhisperBackend } from "./whisper-backend.ts";

/** Stop the server after this long without a request. Re-starting costs ~0.9 s. */
export const IDLE_STOP_MS = 10 * 60_000;
/** A cold model load from disk; a warm one takes under a second. */
const STARTUP_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;
const INFERENCE_TIMEOUT_MS = 60_000;

/**
 * The server could not be used — the caller should use whisper-cli.
 * `startup`: it never came up (missing binary or model, crashed while
 * loading, timed out), so trying again will not help. `request`: it was
 * running and stopped answering, so the next call may restart it.
 */
export class WhisperServerUnavailableError extends Error {
  constructor(
    message: string,
    readonly phase: "startup" | "request"
  ) {
    super(message);
    this.name = "WhisperServerUnavailableError";
  }
}

export interface WhisperServerOptions {
  bin: string;
  model: string;
  threads: number;
  idleStopMs?: number;
  startupTimeoutMs?: number;
  /** Injected in tests. */
  spawnProcess?: (bin: string, args: string[]) => ChildProcess;
  /** Injected in tests. */
  findPort?: () => Promise<number>;
}

/** An unused loopback port: bind to 0, read what the OS picked, release it. */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not determine a free port"));
      });
    });
  });
}

/** The server's arguments. Pure, so the flags that matter are pinned by tests. */
export function buildServerArgs(model: string, port: number, threads: number): string[] {
  return [
    "-m", model,
    "--host", "127.0.0.1",
    "--port", String(port),
    "-t", String(threads),
    "-l", "auto",
    // Plain text, as whisper-cli's --output-txt produced it.
    "--no-timestamps",
    // verbose_json otherwise runs a separate language-detection pass on every
    // request just to fill in probabilities nobody here reads.
    "--no-language-probabilities"
  ];
}

const LANGUAGE_CODES = new Map(LANGUAGES.map((language) => [language.name.toLowerCase(), language.code]));

/**
 * The server names the language ("ukrainian"); callers expect the ISO code
 * whisper-cli reported ("uk"). Unknown names map to undefined rather than to
 * a guess — the field is informational (meeting manifest, debug log).
 */
export function languageCodeFromName(name: unknown): string | undefined {
  if (typeof name !== "string" || name.length === 0) return undefined;
  if (/^[a-z]{2}$/u.test(name)) return name;
  return LANGUAGE_CODES.get(name.toLowerCase());
}

export class WhisperServer {
  private child: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<number> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly idleStopMs: number;
  private readonly startupTimeoutMs: number;
  private readonly spawnProcess: (bin: string, args: string[]) => ChildProcess;
  private readonly findPort: () => Promise<number>;

  constructor(private readonly options: WhisperServerOptions) {
    this.idleStopMs = options.idleStopMs ?? IDLE_STOP_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.spawnProcess = options.spawnProcess ?? ((bin, args) => spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] }));
    this.findPort = options.findPort ?? findFreePort;
  }

  get isRunning(): boolean {
    return this.child !== null && this.port > 0;
  }

  async transcribe(wavPath: string, options: TranscribeOptions = {}): Promise<TranscribeResult> {
    const port = await this.ensureStarted();
    this.touch();
    const wav = await fs.readFile(wavPath);
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), path.basename(wavPath));
    form.append("response_format", "verbose_json");
    form.append("temperature", "0.0");
    form.append("language", options.language && options.language.length > 0 ? options.language : "auto");
    if (options.prompt && options.prompt.length > 0) form.append("prompt", options.prompt);

    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS)
      });
    } catch (err) {
      // Stopped answering: kill it rather than just forget it — a hung
      // process would otherwise keep the model's memory for nothing — and
      // let the next call start a fresh one.
      this.stop();
      throw new WhisperServerUnavailableError(
        `whisper-server unreachable: ${err instanceof Error ? err.message : String(err)}`,
        "request"
      );
    }
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`whisper-server ${response.status}: ${body.slice(0, 300)}`);
    }
    const parsed = JSON.parse(body) as { text?: unknown; language?: unknown; error?: unknown };
    if (typeof parsed.error === "string") throw new Error(`whisper-server: ${parsed.error}`);
    return {
      text: typeof parsed.text === "string" ? parsed.text.trim() : "",
      language: languageCodeFromName(parsed.language)
    };
  }

  /** Starts the process once; concurrent callers share the same start. */
  async ensureStarted(): Promise<number> {
    if (this.isRunning) return this.port;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    this.forget();
    child?.kill();
  }

  private async start(): Promise<number> {
    if (!existsSync(this.options.bin)) {
      throw new WhisperServerUnavailableError(`whisper-server binary not found at ${this.options.bin}`, "startup");
    }
    if (!existsSync(this.options.model)) {
      throw new WhisperServerUnavailableError(`whisper model not found at ${this.options.model}`, "startup");
    }
    const port = await this.findPort();
    const child = this.spawnProcess(this.options.bin, buildServerArgs(this.options.model, port, this.options.threads));
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      // Keep only the tail: the model load prints a lot, and only the end explains a failure.
      stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
    });
    let exited = false;
    child.once("exit", () => {
      exited = true;
      if (this.child === child) this.forget();
    });
    child.once("error", () => {
      exited = true;
    });

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        throw new WhisperServerUnavailableError(`whisper-server exited during startup: ${stderr.trim().slice(-300)}`, "startup");
      }
      try {
        const probe = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
        if (probe.ok) {
          this.child = child;
          this.port = port;
          this.touch();
          return port;
        }
      } catch {
        // Not listening yet — the model is still loading.
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    child.kill();
    throw new WhisperServerUnavailableError(`whisper-server not ready after ${this.startupTimeoutMs} ms`, "startup");
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleStopMs);
    this.idleTimer.unref();
  }

  private forget(): void {
    this.child = null;
    this.port = 0;
  }
}

/**
 * whisper.cpp with the model kept resident, falling back to `whisper-cli`.
 *
 * No request ever waits for the server to come up. The first start after an
 * install took 13 s on an M3 Pro (Gatekeeper checks the freshly signed binary
 * once), and a start after an idle stop still takes ~1 s — about what
 * whisper-cli costs on its own. So while the server is not running, it is
 * started in the background and the request at hand goes to whisper-cli:
 * nothing is ever slower than before #218, and the speed-up applies from the
 * first request after the server is ready.
 *
 * A server that cannot start is not retried for the rest of the session. A
 * server that was working and then went away is restarted in the background.
 */
export class ResidentWhisperBackend implements WhisperBackend {
  private serverDisabled = false;

  constructor(
    private readonly server: WhisperServer,
    private readonly fallback: WhisperBackend
  ) {}

  async transcribe(wavPath: string, options: TranscribeOptions = {}): Promise<TranscribeResult> {
    if (this.serverDisabled) return this.fallback.transcribe(wavPath, options);
    if (!this.server.isRunning) {
      this.warmUp();
      return this.fallback.transcribe(wavPath, options);
    }
    try {
      return await this.server.transcribe(wavPath, options);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[whisper] resident server failed this request, retrying with whisper-cli: ${detail}`);
      return this.fallback.transcribe(wavPath, options);
    }
  }

  /**
   * The resident server only, or null while it is not running (and warming
   * up). For work that is worth doing only when it is cheap: a live caption
   * partial taken through whisper-cli would cost 1.6 s and slow the final
   * behind it (#219), so it is better skipped than sent there.
   */
  async transcribeIfResident(wavPath: string, options: TranscribeOptions = {}): Promise<TranscribeResult | null> {
    if (this.serverDisabled) return null;
    if (!this.server.isRunning) {
      this.warmUp();
      return null;
    }
    return this.server.transcribe(wavPath, options);
  }

  /** Starts the server without anyone waiting on it; a startup failure disables it for the session. */
  warmUp(): void {
    if (this.serverDisabled) return;
    this.server.ensureStarted().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof WhisperServerUnavailableError && err.phase === "startup") {
        this.serverDisabled = true;
        console.warn(`[whisper] resident server unavailable, using whisper-cli from now on: ${detail}`);
      } else {
        console.warn(`[whisper] resident server did not start: ${detail}`);
      }
    });
  }
}

let shared: WhisperServer | null = null;
let sharedKey = "";

/** The one server for the app. Recreated if the binary, model or threads change. */
export function sharedWhisperServer(options: WhisperServerOptions): WhisperServer {
  const key = `${options.bin}\u0000${options.model}\u0000${options.threads}`;
  if (shared && sharedKey === key) return shared;
  shared?.stop();
  shared = new WhisperServer(options);
  sharedKey = key;
  return shared;
}

/** Called on app quit so the model's memory is released with the app. */
export function stopSharedWhisperServer(): void {
  shared?.stop();
  shared = null;
  sharedKey = "";
}
