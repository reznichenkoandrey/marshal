import path from "node:path";

import { createReasoningBridge } from "../bridge/factory.ts";
import { AgentLoop } from "../core/agent-loop.ts";
import { Planner } from "../core/planner.ts";
import { ALL_TOOL_NAMES, createInitialSystemPrompt, type ToolName } from "../core/protocol.ts";
import { MemoryStore } from "../memory/store.ts";
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
  onEvent?: (event: MarshalRuntimeEvent) => Promise<void> | void;
};

export async function runMarshalTask(options: RunMarshalTaskOptions): Promise<string> {
  const route = options.route ?? "auto";
  const bridge = createReasoningBridge({ projectName: options.chatProjectName });
  const memory = new MemoryStore(options.memoryDir);
  const sandbox = new FileSandbox(options.workspaceRoot);
  const browserManager = new PlaywrightBrowserManager(false);
  const allowedTools = ROUTE_TOOL_MAP[route];
  const task = buildExecutionTask(options.task, route, options.attachments ?? [], sandbox.root);

  try {
    await Promise.all([bridge.initialize(), memory.initialize(), sandbox.initialize()]);
    await options.onEvent?.({
      type: "task_started",
      route,
      workspaceRoot: sandbox.root
    });
    await bridge.resetConversation();
    await bridge.prime(createInitialSystemPrompt(allowedTools));
    await options.onEvent?.({
      type: "planning_started",
      route
    });

    const planner = new Planner(bridge);
    const plan = await planner.createPlan(task, {
      availableTools: allowedTools,
      routeMode: route
    });
    await options.onEvent?.({
      type: "plan_ready",
      steps: plan.steps
    });

    const tools = new Toolbox(
      sandbox,
      new ShellTool(sandbox.root),
      new BrowserTool(browserManager),
      allowedTools
    );
    const agentLoop = new AgentLoop(bridge, memory, tools, {
      availableTools: allowedTools,
      workspaceRoot: sandbox.root,
      onEvent: options.onEvent
    });
    const result = await agentLoop.runTask(task, plan.steps);
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
  workspaceRoot: string
): string {
  const routeInstructions =
    route === "auto"
      ? "Execution route: auto. Use the available tools that best fit the task."
      : route === "local"
        ? "Execution route: local only. Do not rely on browser automation."
        : "Execution route: browser only. Do not rely on local filesystem or shell tools.";
  const workspaceInstructions =
    route === "browser"
      ? "Local workspace access is disabled for this task."
      : [
          `Workspace root: ${workspaceRoot}`,
          "Filesystem and shell tools can only access paths inside this workspace root.",
          "If the user requests an absolute path or any location outside this workspace root, do not claim success there. State the limitation clearly."
        ].join("\n");

  const attachmentBlock =
    attachments.length === 0
      ? "Attachments: none."
      : [
          "Attachments:",
          ...attachments.map(
            (attachment, index) =>
              `${index + 1}. ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes) at workspace path ${attachment.relativePath}`
          )
        ].join("\n");

  return [routeInstructions, workspaceInstructions, attachmentBlock, "User request:", task].join("\n\n");
}
