import type { MarshalRuntimeEvent } from "../runtime/types.ts";
import type { Toolbox } from "../tools/index.ts";
import type { ToolExecutionResult, ToolName } from "./protocol.ts";

type OneShotBridge = {
  ask(prompt: string): Promise<string>;
};

type ToolCall = {
  tool: string;
  input: Record<string, unknown>;
};

type OneShotOptions = {
  availableTools: ToolName[];
  workspaceRoot: string;
  unrestricted: boolean;
  onEvent?: (event: MarshalRuntimeEvent) => Promise<void> | void;
  /** Cap how many request→tools→request round-trips we allow. Default 6. */
  maxIterations?: number;
};

const DEFAULT_MAX_ITERATIONS = 5;
// Cap individual tool-result strings so extremely long file reads or shell
// dumps don't blow the model's context window. 40 KB per tool per round.
const MAX_RESULT_BYTES = 40 * 1024;
const DEBUG = process.env.MARSHAL_AGENT_DEBUG === "1";

/**
 * Executor for the JSON-command protocol. Drives a loop:
 *   1. Ask bridge with the task prompt.
 *   2. Parse {commands, summary} from response.
 *   3. If commands is empty → summary is the final answer, return.
 *   4. Otherwise execute each command, feed the results back to the bridge,
 *      and go to step 1 (next iteration).
 *
 * The bridge keeps conversation state across iterations (Claude CLI --resume,
 * API turn history, etc.) so subsequent asks don't re-send the task prompt —
 * they only carry the new tool results.
 *
 * Name kept as `OneShotExecutor` for git-blame continuity; behaviour is now
 * multi-round. Upstream `runMarshalTask` creates a fresh bridge session per
 * task via `bridge.resetConversation()`, so iterations here are safely scoped
 * to the current user message.
 */
export class OneShotExecutor {
  private bridge: OneShotBridge;
  private tools: Toolbox;
  private options: OneShotOptions;

  constructor(bridge: OneShotBridge, tools: Toolbox, options: OneShotOptions) {
    this.bridge = bridge;
    this.tools = tools;
    this.options = options;
  }

  async execute(task: string): Promise<string> {
    const maxIterations = this.options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    let currentPrompt: string = this.buildPrompt(task);
    let lastSummary = "";
    let totalSteps = 0;

    for (let iter = 0; iter < maxIterations; iter++) {
      // Emit a planning event per iteration so the UI timeline keeps ticking
      // — otherwise mid-task rounds leave the user staring at a typing
      // indicator for 10-30 s while the model thinks.
      await this.options.onEvent?.({ type: "planning_started", route: "auto" });
      if (DEBUG) {
        process.stderr.write(`[executor] iter ${iter + 1}/${maxIterations} → bridge.ask (${currentPrompt.length}B)\n`);
      }

      const askStartedAt = Date.now();
      const response = await this.bridge.ask(currentPrompt);
      if (DEBUG) {
        process.stderr.write(`[executor] iter ${iter + 1} ← ${response.length}B in ${Date.now() - askStartedAt}ms\n`);
      }
      let parsed = this.parseResponse(response);

      // On the first iteration, if the model ignored the JSON format, ask
      // once more with an explicit reminder. Subsequent iterations assume the
      // format has been learned.
      if (
        iter === 0 &&
        parsed.toolCalls.length === 0 &&
        !response.includes('"commands"') &&
        !response.includes('"summary"')
      ) {
        const retry = await this.bridge.ask(
          'Respond with ONLY a JSON object like: {"commands": [], "summary": "your answer"}'
        );
        const retryParsed = this.parseResponse(retry);
        if (retryParsed.toolCalls.length > 0 || retry.includes('"commands"')) {
          parsed = retryParsed;
        }
      }

      const { toolCalls, summary } = parsed;
      if (summary) lastSummary = summary;

      if (toolCalls.length === 0) {
        // Model has nothing more to execute — the summary IS the final answer.
        return summary || lastSummary || "No response from AI.";
      }

      // Per-iteration plan_ready so the timeline reflects newly planned tools
      // whenever the model pivots mid-task, not only on the very first round.
      await this.options.onEvent?.({
        type: "plan_ready",
        steps: toolCalls.map((tc) => `${tc.tool}: ${JSON.stringify(tc.input)}`)
      });

      const results: ToolExecutionResult[] = [];
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const toolName = call.tool as ToolName;
        const stepIndex = totalSteps++;
        const stepLabel = `${call.tool}: ${JSON.stringify(call.input)}`;

        await this.options.onEvent?.({
          type: "step_started",
          step: stepLabel,
          stepIndex,
          totalSteps: stepIndex + 1,
          iteration: iter + 1
        });
        await this.options.onEvent?.({
          type: "action_requested",
          step: stepLabel,
          stepIndex,
          action: toolName,
          thought: summary || `Executing ${call.tool}`,
          input: call.input
        });

        try {
          const result = await this.tools.execute(toolName, call.input);
          results.push(result);
          await this.options.onEvent?.({
            type: "tool_completed",
            step: stepLabel,
            stepIndex,
            action: toolName,
            summary: result.summary
          });
          await this.options.onEvent?.({
            type: "step_completed",
            step: stepLabel,
            stepIndex,
            totalSteps: stepIndex + 1,
            summary: result.summary
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          await this.options.onEvent?.({
            type: "tool_failed",
            step: stepLabel,
            stepIndex,
            action: toolName,
            error: errorMsg
          });
          results.push({
            ok: false,
            tool: toolName,
            summary: `Failed: ${errorMsg}`,
            data: { error: errorMsg }
          });
        }
      }

      currentPrompt = this.buildFollowupPrompt(results);
    }

    return (
      lastSummary ||
      `Reached the ${maxIterations}-iteration cap before the model produced a final answer.`
    );
  }

  private buildPrompt(task: string): string {
    const toolDocs = this.options.availableTools.map((name) => {
      switch (name) {
        case "write_file":
          return `- write_file: Create/overwrite a file.\n  Input: {"path": "absolute or relative path", "content": "file contents"}`;
        case "read_file":
          return `- read_file: Read a file. Auto-extracts plain text from .docx, .doc, .rtf, .pages on macOS (no need to unzip).\n  Input: {"path": "absolute or relative path"}`;
        case "list_dir":
          return `- list_dir: List directory contents.\n  Input: {"path": "absolute or relative path"}`;
        case "run_shell":
          return `- run_shell: Execute a shell command (zsh).\n  Input: {"cmd": "command string"}`;
        case "browser_navigate":
          return `- browser_navigate: Open a URL.\n  Input: {"url": "https://..."}`;
        case "browser_click":
          return `- browser_click: Click an element.\n  Input: {"selector": "CSS or text selector"}`;
        case "browser_type":
          return `- browser_type: Type text into an element.\n  Input: {"selector": "CSS selector", "text": "text to type"}`;
        default:
          return `- ${name}`;
      }
    }).join("\n");

    const fsNote = this.options.unrestricted
      ? `Working directory: ${this.options.workspaceRoot}\nYou can use absolute paths anywhere on the filesystem.`
      : `Workspace root: ${this.options.workspaceRoot}\nAll file paths must be inside this workspace.`;

    return `You are a task execution agent. Work in rounds: plan tools, receive their results, then decide what to do next.

TASK: ${task}

${fsNote}

AVAILABLE TOOLS:
${toolDocs}

RESPONSE FORMAT (strict JSON, nothing else):
{"commands": [{"tool": "tool_name", "input": {...}}], "summary": "short status OR final answer"}

RULES:
- If you need to read files, inspect state, or run shell commands to answer, put those calls in "commands". The system will execute them and come back to you with the results on the next round.
- Only return commands: [] when you have enough information to answer the user — at that point "summary" must contain the FINAL answer written for the user, not a plan.
- If a prior attachment has already been read in earlier commands or by the user in previous turns, use that content directly instead of re-reading.
- NEVER include markdown, backticks, or explanations outside the JSON.
- The response MUST start with { and end with }.`;
  }

  /**
   * Next-round prompt: just the previous round's tool results. The bridge
   * already holds the full conversation (task + prior assistant JSON), so we
   * don't re-send the task here.
   */
  private buildFollowupPrompt(results: ToolExecutionResult[]): string {
    const resultBlocks = results.map((r, i) => {
      const header = `Tool ${i + 1}: ${r.tool} — ${r.ok ? "ok" : "failed"}`;
      const body = truncateForPrompt(formatResultBody(r));
      return `${header}\n${body}`;
    }).join("\n\n---\n\n");

    return `Tool results from the last round:

${resultBlocks}

Respond with the same JSON object format:
- If you still need more tool calls, include them in "commands".
- If you now have enough to answer the user, return {"commands": [], "summary": "<final answer for the user>"}.

JSON only — no markdown, no prose outside the JSON.`;
  }

  private parseResponse(response: string): { toolCalls: ToolCall[]; summary: string } {
    // Find ALL JSON objects with "commands" key, take the LAST one
    // (ChatGPT may echo the prompt including example JSON before responding)
    const candidates: string[] = [];
    let depth = 0;
    let start = -1;

    for (let i = 0; i < response.length; i++) {
      if (response[i] === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (response[i] === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          const candidate = response.slice(start, i + 1);
          if (candidate.includes('"commands"')) {
            candidates.push(candidate);
          }
          start = -1;
        }
      }
    }

    // Take the LAST candidate (actual response, not echoed example)
    for (let i = candidates.length - 1; i >= 0; i--) {
      const result = this.tryParseJson(candidates[i]);
      if (result) return result;
    }

    // No valid JSON with "commands" found — treat the whole response as a text answer
    const cleanText = response
      .replace(/```[\s\S]*?```/g, "")  // strip code blocks
      .replace(/\n{2,}/g, "\n")
      .trim();
    return { toolCalls: [], summary: cleanText || "No response from AI." };
  }

  /**
   * Try parsing a JSON string with multiple fallback strategies.
   * ChatGPT's DOM extraction may mangle escape sequences in JSON strings
   * (e.g. \" becomes " when read via textContent, breaking the JSON).
   */
  private tryParseJson(raw: string): { toolCalls: ToolCall[]; summary: string } | null {
    const attempt = (text: string): { toolCalls: ToolCall[]; summary: string } | null => {
      try {
        const parsed = JSON.parse(text) as { commands?: ToolCall[]; summary?: string };
        if (Array.isArray(parsed.commands)) {
          return {
            toolCalls: parsed.commands,
            summary: typeof parsed.summary === "string" ? parsed.summary : ""
          };
        }
      } catch { /* try next strategy */ }
      return null;
    };

    // Strategy 1: parse as-is
    const result = attempt(raw);
    if (result) return result;

    // Strategy 2: collapse real newlines/tabs into JSON escape sequences
    const collapsed = raw.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    const result2 = attempt(collapsed);
    if (result2) return result2;

    // Strategy 3: repair unescaped quotes inside JSON string values.
    // When textContent strips backslashes, "lang=\"en\"" becomes "lang="en""
    // which breaks JSON parsing. Walk through the string char-by-char to
    // re-escape quotes that appear inside string values.
    const repaired = this.repairJsonEscapes(raw);
    const result3 = attempt(repaired);
    if (result3) return result3;

    // Strategy 4: repair + collapse newlines (combined)
    const repairedCollapsed = this.repairJsonEscapes(collapsed);
    const result4 = attempt(repairedCollapsed);
    if (result4) return result4;

    // Strategy 5: single-line normalization
    const singleLine = raw.replace(/[\n\r\t]+/g, " ").replace(/\s{2,}/g, " ");
    const result5 = attempt(singleLine);
    if (result5) return result5;

    // Strategy 6: repair on single-line
    const repairedSingleLine = this.repairJsonEscapes(singleLine);
    return attempt(repairedSingleLine);
  }

  /**
   * Repair JSON string values where inner quotes lost their backslash escapes.
   *
   * Walks the JSON text character-by-character tracking structural context
   * (inside/outside strings, nesting depth). When an unescaped quote is found
   * in a position that cannot be a valid JSON string terminator (followed by
   * characters that aren't , : ] } or whitespace), it is re-escaped as \".
   *
   * This handles the common ChatGPT DOM extraction artifact where
   * "content":"<html lang=\"en\">" becomes "content":"<html lang="en">".
   */
  private repairJsonEscapes(input: string): string {
    const out: string[] = [];
    let i = 0;
    let inString = false;
    // Track whether current string is a JSON key vs value for heuristic tuning
    let depth = 0;

    while (i < input.length) {
      const ch = input[i];

      if (!inString) {
        out.push(ch);
        if (ch === '"') {
          inString = true;
        } else if (ch === '{' || ch === '[') {
          depth++;
        } else if (ch === '}' || ch === ']') {
          depth--;
        }
        i++;
        continue;
      }

      // Inside a JSON string value
      if (ch === '\\') {
        // Escaped character — pass through as-is
        out.push(ch);
        if (i + 1 < input.length) {
          out.push(input[i + 1]);
          i += 2;
        } else {
          i++;
        }
        continue;
      }

      if (ch === '"') {
        // Determine if this quote is the real string terminator or an
        // unescaped interior quote that needs repair.
        // Look ahead: a valid string terminator is followed by structural
        // JSON characters (possibly with whitespace).
        const rest = input.slice(i + 1).trimStart();
        const nextStructural = rest[0];
        const isTerminator =
          rest.length === 0 ||
          nextStructural === ',' ||
          nextStructural === ':' ||
          nextStructural === '}' ||
          nextStructural === ']';

        if (isTerminator) {
          // Real string terminator
          out.push('"');
          inString = false;
        } else {
          // Interior quote that lost its backslash — re-escape it
          out.push('\\"');
        }
        i++;
        continue;
      }

      out.push(ch);
      i++;
    }

    return out.join('');
  }
}

function formatResultBody(result: ToolExecutionResult): string {
  const parts: string[] = [];
  if (result.summary) parts.push(result.summary);
  const data = result.data ?? {};
  const keys = Object.keys(data);
  if (keys.length > 0) {
    // Prefer the common `content`/`stdout` keys verbatim; fall back to a
    // compact JSON dump of everything else.
    const content =
      typeof (data as { content?: unknown }).content === "string"
        ? String((data as { content?: unknown }).content)
        : typeof (data as { stdout?: unknown }).stdout === "string"
          ? String((data as { stdout?: unknown }).stdout)
          : null;
    if (content !== null) {
      parts.push(content);
    } else {
      try {
        parts.push(JSON.stringify(data, null, 2));
      } catch {
        // Circular or unserialisable — fall through.
      }
    }
  }
  return parts.join("\n").trim();
}

function truncateForPrompt(text: string): string {
  if (text.length <= MAX_RESULT_BYTES) return text;
  const head = text.slice(0, MAX_RESULT_BYTES);
  const droppedBytes = text.length - MAX_RESULT_BYTES;
  return `${head}\n… [truncated ${droppedBytes} bytes]`;
}
