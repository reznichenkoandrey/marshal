import path from "node:path";

import { createReasoningBridge, getBridgeMode } from "../bridge/factory.ts";
import type { ReasoningBridge } from "../bridge/types.ts";
import { OneShotExecutor } from "../core/one-shot-executor.ts";
import { ALL_TOOL_NAMES, type ToolName } from "../core/protocol.ts";
import { BrowserTool } from "../tools/browser.ts";
import { FileSandbox } from "../tools/fs.ts";
import { PlaywrightBrowserManager } from "../tools/playwright-manager.ts";
import { ShellTool } from "../tools/shell.ts";
import { Toolbox } from "../tools/index.ts";
import type {
  ExecutionRoute,
  MarshalRuntimeEvent,
  RuntimeAttachment,
  RuntimePriorMessage
} from "./types.ts";

// "auto" no longer includes browser_* tools. Previously a doc/file question
// could trigger an unwanted Chromium window because the model has a slight
// tendency to reach for browser tools when any are available. Users who
// want web automation should pick the "browser" route explicitly.
const ROUTE_TOOL_MAP: Record<ExecutionRoute, ToolName[]> = {
  auto: ["read_file", "write_file", "list_dir", "run_shell"],
  local: ["read_file", "write_file", "list_dir", "run_shell"],
  browser: ["browser_navigate", "browser_click", "browser_type"]
};

export type RunMarshalTaskOptions = {
  task: string;
  route?: ExecutionRoute;
  attachments?: RuntimeAttachment[];
  /**
   * Prior user/assistant messages from the same chat session, oldest first.
   * Excludes the current user message (which is the `task` arg). When omitted
   * the task runs as a fresh, zero-context conversation — the pre-#73
   * behaviour.
   */
  priorMessages?: RuntimePriorMessage[];
  workspaceRoot?: string;
  memoryDir?: string;
  chatProjectName?: string;
  bridge?: ReasoningBridge;
  browserHeadless?: boolean;
  onEvent?: (event: MarshalRuntimeEvent) => Promise<void> | void;
};

export async function runMarshalTask(options: RunMarshalTaskOptions): Promise<string> {
  const route = options.route ?? "auto";
  const bridgeMode = getBridgeMode();
  const isUnrestricted =
    bridgeMode === "claude-cli" ||
    bridgeMode === "codex-cli" ||
    bridgeMode === "api" ||
    bridgeMode === "claude" ||
    bridgeMode === "claude-web" ||
    bridgeMode === "playwright";
  const bridge = options.bridge ?? createReasoningBridge({ projectName: options.chatProjectName });
  const sandbox = new FileSandbox(options.workspaceRoot, { unrestricted: isUnrestricted });
  // Default to headless for auto/local routes — no reason to pop a visible
  // Chromium window unless the user explicitly picked the "browser" route to
  // watch the automation. Callers can still force visibility via options.
  const browserManager = new PlaywrightBrowserManager(
    options.browserHeadless ?? route !== "browser"
  );
  const allowedTools = ROUTE_TOOL_MAP[route];

  // Build task description with context (prior turns + attachments).
  const taskText = buildExecutionTask(
    options.task,
    route,
    options.attachments ?? [],
    sandbox.root,
    isUnrestricted,
    options.priorMessages ?? []
  );

  try {
    await Promise.all([bridge.initialize(), sandbox.initialize()]);
    await options.onEvent?.({
      type: "task_started",
      route,
      workspaceRoot: sandbox.root
    });

    // Start fresh conversation (no prime — one-shot includes all context in a single prompt)
    await bridge.resetConversation();

    // One-shot execution: single prompt → JSON commands → execute
    const executor = new OneShotExecutor(bridge, new Toolbox(
      sandbox,
      new ShellTool(sandbox.root),
      new BrowserTool(browserManager),
      allowedTools
    ), {
      availableTools: allowedTools,
      workspaceRoot: sandbox.root,
      unrestricted: isUnrestricted,
      onEvent: options.onEvent
    });

    const result = await executor.execute(taskText);

    await options.onEvent?.({
      type: "task_completed",
      result
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown task failure.";
    await options.onEvent?.({
      type: "task_failed",
      error: message
    });
    throw error;
  } finally {
    await bridge.close();
    await browserManager.close();
  }
}

export function getAllowedTools(route: ExecutionRoute): ToolName[] {
  return ROUTE_TOOL_MAP[route];
}

export function getDefaultSessionWorkspace(sessionId: string): string {
  return path.resolve(process.cwd(), "operator-data", "sessions", sessionId, "workspace");
}

export function getDefaultSessionMemory(sessionId: string): string {
  return path.resolve(process.cwd(), "operator-data", "sessions", sessionId, "memory");
}

/**
 * Build the single prompt string fed to the reasoning bridge. Includes:
 *   - full prior conversation (user + assistant), so the model sees context;
 *   - the current user message with a route hint;
 *   - a consolidated attachment list with absolute paths — from both the
 *     current turn and any prior turn. The model can re-read old uploads via
 *     the `read_file` tool even when the user didn't re-attach them.
 *
 * Exported for unit testing. In production it's only called from
 * {@link runMarshalTask}.
 */
export function buildExecutionTask(
  task: string,
  route: ExecutionRoute,
  attachments: RuntimeAttachment[],
  workspaceRoot: string,
  _unrestricted = false,
  priorMessages: RuntimePriorMessage[] = []
): string {
  const routeHint =
    route === "browser" ? " (use browser tools only)" :
    route === "local" ? " (use file/shell tools only)" : "";

  const historyBlock = formatHistoryBlock(priorMessages);

  // Consolidate ALL attachments the user has ever uploaded in this chat —
  // current turn + every prior turn — deduplicated by id, using absolute
  // paths so the model can read them regardless of sandbox root. Without
  // this, turn-2 follow-up questions about a turn-1 .docx fell back to
  // hallucination (#73).
  const priorAttachments = priorMessages.flatMap((m) => m.attachments);
  const seen = new Set<string>();
  const mergedAttachments: RuntimeAttachment[] = [];
  for (const a of [...priorAttachments, ...attachments]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    mergedAttachments.push(a);
  }

  const attachmentBlock =
    mergedAttachments.length === 0
      ? ""
      : "\n\nAttachments (available for the entire chat, read via read_file if needed):\n" +
        mergedAttachments.map(
          (a, i) => `${i + 1}. ${a.name} (${a.mimeType}) at ${a.absolutePath}`
        ).join("\n");

  const currentBlock = historyBlock.length > 0
    ? `New message from user:\n${task}${routeHint}`
    : `${task}${routeHint}`;

  return `${historyBlock}${currentBlock}${attachmentBlock}`;
}

function formatHistoryBlock(priorMessages: RuntimePriorMessage[]): string {
  if (priorMessages.length === 0) return "";

  const lines: string[] = ["Previous conversation in this chat:\n"];
  let turnIndex = 0;
  for (const msg of priorMessages) {
    if (msg.role === "user") {
      turnIndex += 1;
      lines.push(`User (turn ${turnIndex}):`);
      lines.push(msg.text.trim());
      if (msg.attachments.length > 0) {
        const names = msg.attachments.map((a) => a.name).join(", ");
        lines.push(`[User attached: ${names}]`);
      }
    } else {
      lines.push(`Assistant (turn ${turnIndex}):`);
      lines.push(msg.text.trim());
    }
    lines.push("");
  }
  lines.push("---\n");
  return lines.join("\n");
}
