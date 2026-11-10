import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  AlternativesRequest,
  AlternativesResult,
  TargetLang,
  TranslateOptions,
  TranslationResult,
  TranslatorBackend,
  TranslatorBackendId
} from "./types.ts";
import { buildAlternativesPrompt, parseAlternativesJson } from "./alternatives.ts";
import {
  buildOcrTranslateJsonPrompt,
  buildTranslateJsonPrompt,
  claudeImageMediaType,
  parseTranslateJson,
  resolveSourceLang
} from "./shared.ts";

const CLAUDE_BIN = process.env.MARSHAL_CLAUDE_BIN ?? "claude";
/**
 * Not MARSHAL_CLAUDE_MODEL: that one is the agent's model (Settings sets it,
 * usually opus) and made every translation take 11+ seconds (#344).
 */
const DEFAULT_TRANSLATOR_MODEL = "haiku";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
/** A warm spare costs ~117 MB; idle Marshal has a 300 MB budget (#281). */
const SPARE_IDLE_MS = 10 * 60_000;
const SYSTEM_PROMPT =
  "You are a translation engine inside a desktop translator. " +
  "Do exactly what the user message asks and reply only in the format it asks for.";

export function translatorClaudeModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.MARSHAL_TRANSLATOR_CLAUDE_MODEL?.trim() || DEFAULT_TRANSLATOR_MODEL;
}

/**
 * A lean, one-request `claude -p`. Each flag removes startup work or a stall
 * measured on 2.1.322: user/project settings bring hooks, plugins and every
 * configured MCP server (~2.7 s of startup), and the default system prompt is
 * a coding agent's. Input is stream-json so the process can start before the
 * request exists — plain `-p` gives up on an empty stdin after 3 s.
 */
export function claudeTranslatorArgs(model: string): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--exclude-dynamic-system-prompt-sections",
    "--system-prompt", SYSTEM_PROMPT
  ];
}

/**
 * Claude Code bills an API key whenever ANTHROPIC_API_KEY is present; strip
 * those so translations stay on the Pro/Max subscription. Non-essential
 * traffic off: otherwise the CLI holds `result` back ~1.7 s for a
 * post-turn summary nobody reads.
 */
export function claudeTranslatorEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("ANTHROPIC_")) continue;
    if (key === "CLAUDE_CODE_USE_BEDROCK" || key === "CLAUDE_CODE_USE_VERTEX") continue;
    if (typeof value === "string") clean[key] = value;
  }
  clean.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return clean;
}

type UserContent =
  | string
  | Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  >;

interface StreamResultLine {
  type?: string;
  is_error?: boolean;
  result?: string;
}

/**
 * The answer in one stream-json stdout line, or null when the line is not the
 * final `result` (init, assistant chunks, rate-limit events, partial JSON).
 */
export function parseStreamResult(line: string): { ok: boolean; text: string } | null {
  let parsed: StreamResultLine;
  try {
    parsed = JSON.parse(line) as StreamResultLine;
  } catch {
    return null;
  }
  if (parsed.type !== "result") return null;
  return { ok: parsed.is_error !== true, text: parsed.result ?? "" };
}

/** One `claude` process that answers exactly one request. */
class ClaudeRequestProcess {
  readonly model: string;
  private readonly child: ChildProcessWithoutNullStreams | null;
  private spawnError: Error | null = null;
  private exited = false;
  private stdout = "";
  private stdoutBytes = 0;
  private stderr = "";
  private settle: ((outcome: { text?: string; error?: Error }) => void) | null = null;

  constructor(model: string) {
    this.model = model;
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      child = spawn(CLAUDE_BIN, claudeTranslatorArgs(model), {
        stdio: ["pipe", "pipe", "pipe"],
        env: claudeTranslatorEnv(process.env)
      });
    } catch (err) {
      this.spawnError = spawnFailure(err);
    }
    this.child = child;
    if (!child) return;

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderr.length < 4000) this.stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      this.spawnError = spawnFailure(err);
      this.finish({ error: this.spawnError });
    });
    child.on("close", (code) => {
      this.exited = true;
      const detail = this.stderr.trim().slice(0, 500) || this.stdout.trim().slice(0, 500) || "(no output)";
      this.finish({ error: new Error(`${CLAUDE_BIN} exited with code ${code} before answering: ${detail}`) });
    });
    // An idle spare must not keep Marshal's event loop alive on quit.
    child.unref();
  }

  /** Still able to take a request: spawned, not exited, never asked. */
  get usable(): boolean {
    return this.child !== null && !this.exited && this.spawnError === null && this.settle === null;
  }

  ask(content: UserContent): Promise<string> {
    if (this.spawnError) return Promise.reject(this.spawnError);
    if (!this.child || this.exited) return Promise.reject(new Error(`${CLAUDE_BIN} is not running`));

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish({ error: new Error(`Claude CLI timed out after ${REQUEST_TIMEOUT_MS}ms`) });
      }, REQUEST_TIMEOUT_MS);
      this.settle = ({ text, error }) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(text ?? "");
      };
      const message = { type: "user", message: { role: "user", content } };
      this.child!.stdin.end(`${JSON.stringify(message)}\n`);
    });
  }

  kill(): void {
    if (this.child && !this.exited) this.child.kill("SIGTERM");
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > MAX_STDOUT_BYTES) {
      this.finish({ error: new Error(`Claude CLI stdout exceeded ${MAX_STDOUT_BYTES} bytes`) });
      return;
    }
    this.stdout += chunk.toString("utf8");
    let newline = this.stdout.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      const result = parseStreamResult(line);
      if (result) {
        this.finish(result.ok
          ? { text: result.text }
          : { error: new Error(`Claude CLI reported an error: ${result.text || "unknown"}`) });
        return;
      }
      newline = this.stdout.indexOf("\n");
    }
  }

  private finish(outcome: { text?: string; error?: Error }): void {
    const settle = this.settle;
    if (!settle) return;
    this.settle = () => {};
    settle(outcome);
    this.kill();
  }
}

/**
 * Keeps one process started ahead of the next request, so a translation pays
 * for the model call (~1 s on haiku) and not for Claude Code's startup on top
 * of it. A fresh process per request means no conversation grows between
 * translations and overlapping requests never queue behind each other.
 */
class ClaudeProcessPool {
  private spare: ClaudeRequestProcess | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  take(): ClaudeRequestProcess {
    const model = translatorClaudeModel();
    const spare = this.spare;
    this.spare = null;
    const chosen = spare && spare.usable && spare.model === model ? spare : new ClaudeRequestProcess(model);
    if (spare && spare !== chosen) spare.kill();
    this.warm();
    return chosen;
  }

  warm(): void {
    if (!this.spare || !this.spare.usable) {
      this.spare?.kill();
      this.spare = new ClaudeRequestProcess(translatorClaudeModel());
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), SPARE_IDLE_MS);
    this.idleTimer.unref();
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.spare?.kill();
    this.spare = null;
  }
}

/**
 * Translator backend on the local `claude` CLI, billed to the user's Claude
 * subscription instead of an API key. Requires `claude` on PATH and
 * `claude auth` done. Images go to the model directly as an image block.
 */
export class ClaudeCliTranslatorBackend implements TranslatorBackend {
  readonly id: TranslatorBackendId = "claude-cli";
  private readonly pool = new ClaudeProcessPool();

  async translateText(text: string, targetLang: TargetLang, options?: TranslateOptions): Promise<TranslationResult> {
    const raw = await this.ask(buildTranslateJsonPrompt(text, targetLang, options));
    const parsed = parseTranslateJson(raw);
    return {
      translation: parsed.translation,
      sourceLang: resolveSourceLang(text, parsed.sourceLang, options),
      targetLang
    };
  }

  async suggestAlternatives(request: AlternativesRequest): Promise<AlternativesResult> {
    const raw = await this.ask(buildAlternativesPrompt(request));
    return { alternatives: parseAlternativesJson(raw, request.word) };
  }

  async translateImage(
    base64: string,
    mimeType: string,
    targetLang: TargetLang,
    options?: TranslateOptions
  ): Promise<TranslationResult> {
    const raw = await this.ask([
      { type: "image", source: { type: "base64", media_type: claudeImageMediaType(mimeType), data: base64 } },
      { type: "text", text: buildOcrTranslateJsonPrompt(targetLang, options) }
    ]);
    const parsed = parseTranslateJson(raw);
    const sourceText = parsed.source ?? "";
    const result: TranslationResult = {
      translation: parsed.translation,
      sourceLang: resolveSourceLang(sourceText, parsed.sourceLang, options),
      targetLang
    };
    if (sourceText) result.sourceText = sourceText;
    return result;
  }

  warmUp(): void {
    this.pool.warm();
  }

  dispose(): void {
    this.pool.dispose();
  }

  private ask(content: UserContent): Promise<string> {
    return this.pool.take().ask(content);
  }
}

function spawnFailure(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Failed to spawn ${CLAUDE_BIN}: ${message}. Install Claude Code CLI and run \`claude auth\`.`);
}
