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
import type { ExecutionRoute, MarshalRuntimeEvent, RuntimeAttachment } from "./types.ts";

const ROUTE_TOOL_MAP: Record<ExecutionRoute, ToolName[]> = {
  auto: ALL_TOOL_NAMES,
  local: ["read_file", "write_file", "list_dir", "run_shell"],
  browser: ["browser_navigate", "browser_click", "browser_type"]
};

export type RunMarshalTaskOptions = {
  task: string;
  route?: ExecutionRoute;
  attachments?: RuntimeAttachment[];
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
  const browserManager = new PlaywrightBrowserManager(options.browserHeadless ?? false);
  const allowedTools = ROUTE_TOOL_MAP[route];

  // Build task description with context
  const taskText = buildExecutionTask(options.task, route, options.attachments ?? [], sandbox.root, isUnrestricted);

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

function buildExecutionTask(
  task: string,
  route: ExecutionRoute,
  attachments: RuntimeAttachment[],
  workspaceRoot: string,
  _unrestricted = false
): string {
  const attachmentBlock =
    attachments.length === 0
      ? ""
      : "\n\nAttachments:\n" + attachments.map(
          (a, i) => `${i + 1}. ${a.name} (${a.mimeType}) at ${a.relativePath}`
        ).join("\n");

  const routeHint =
    route === "browser" ? " (use browser tools only)" :
    route === "local" ? " (use file/shell tools only)" : "";

  return `${task}${routeHint}${attachmentBlock}`;
}
