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
};

/**
 * One-shot executor: sends a SINGLE prompt to the LLM with the task + tool schemas,
 * receives a JSON array of tool calls + summary, executes them sequentially.
 * Much simpler than the multi-round AgentLoop.
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
    const prompt = this.buildPrompt(task);

    await this.options.onEvent?.({ type: "planning_started", route: "auto" });

    // Single LLM call — get all tool commands at once
    let response = await this.bridge.ask(prompt);
    let parsed = this.parseResponse(response);

    // Retry once if the response didn't contain the expected JSON format
    if (parsed.toolCalls.length === 0 && !response.includes('"commands"') && !response.includes('"summary"')) {
      response = await this.bridge.ask('Respond with ONLY a JSON object like: {"commands": [], "summary": "your answer"}');
      const retryParsed = this.parseResponse(response);
      if (retryParsed.toolCalls.length > 0 || response.includes('"commands"')) {
        parsed = retryParsed;
      }
      // If retry also failed, keep original parsed (which has the text as summary)
    }

    const { toolCalls, summary } = parsed;

    await this.options.onEvent?.({
      type: "plan_ready",
      steps: toolCalls.map((tc) => `${tc.tool}: ${JSON.stringify(tc.input)}`)
    });

    // Execute each tool call sequentially
    const results: ToolExecutionResult[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      const toolName = call.tool as ToolName;

      await this.options.onEvent?.({
        type: "step_started",
        step: `${call.tool}: ${JSON.stringify(call.input)}`,
        stepIndex: i,
        totalSteps: toolCalls.length,
        iteration: 1
      });

      const stepLabel = `${call.tool}: ${JSON.stringify(call.input)}`;

      await this.options.onEvent?.({
        type: "action_requested",
        step: stepLabel,
        stepIndex: i,
        action: toolName,
        thought: `Executing ${call.tool}`,
        input: call.input
      });

      try {
        const result = await this.tools.execute(toolName, call.input);
        results.push(result);

        await this.options.onEvent?.({
          type: "tool_completed",
          step: stepLabel,
          stepIndex: i,
          action: toolName,
          summary: result.summary
        });

        await this.options.onEvent?.({
          type: "step_completed",
          step: stepLabel,
          stepIndex: i,
          totalSteps: toolCalls.length,
          summary: result.summary
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        await this.options.onEvent?.({
          type: "tool_failed",
          step: stepLabel,
          stepIndex: i,
          action: toolName,
          error: errorMsg
        });

        // Continue with remaining tool calls (don't abort on single failure)
        results.push({
          ok: false,
          tool: toolName,
          summary: `Failed: ${errorMsg}`,
          data: { error: errorMsg }
        });
      }
    }

    // Build final result
    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    const resultSummary = summary || `Executed ${succeeded}/${toolCalls.length} commands${failed > 0 ? ` (${failed} failed)` : ""}.`;

    return resultSummary;
  }

  private buildPrompt(task: string): string {
    const toolDocs = this.options.availableTools.map((name) => {
      switch (name) {
        case "write_file":
          return `- write_file: Create/overwrite a file.\n  Input: {"path": "absolute or relative path", "content": "file contents"}`;
        case "read_file":
          return `- read_file: Read a file.\n  Input: {"path": "absolute or relative path"}`;
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

    return `You are a task execution agent. Analyze the task and respond with a JSON object.

TASK: ${task}

${fsNote}

AVAILABLE TOOLS:
${toolDocs}

RESPONSE FORMAT (strict JSON, nothing else):
{"commands": [{"tool": "tool_name", "input": {...}}], "summary": "what was done"}

RULES:
- If the task requires file operations or shell commands, include them in "commands".
- If the task is a simple question or greeting that needs no tools, respond with: {"commands": [], "summary": "your answer here"}
- NEVER include markdown, backticks, or explanations outside the JSON.
- The response MUST start with { and end with }.`;
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
