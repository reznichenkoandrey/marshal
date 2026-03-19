import path from "node:path";
import { createReasoningBridge } from "../bridge/factory.js";
import { AgentLoop } from "../core/agent-loop.js";
import { Planner } from "../core/planner.js";
import { ALL_TOOL_NAMES, createInitialSystemPrompt } from "../core/protocol.js";
import { MemoryStore } from "../memory/store.js";
import { BrowserTool } from "../tools/browser.js";
import { FileSandbox } from "../tools/fs.js";
import { PlaywrightBrowserManager } from "../tools/playwright-manager.js";
import { ShellTool } from "../tools/shell.js";
import { Toolbox } from "../tools/index.js";
const ROUTE_TOOL_MAP = {
    auto: ALL_TOOL_NAMES,
    local: ["read_file", "write_file", "list_dir", "run_shell"],
    browser: ["browser_navigate", "browser_click", "browser_type"]
};
export async function runMarshalTask(options) {
    const route = options.route ?? "auto";
    const bridge = createReasoningBridge({ projectName: options.chatProjectName });
    const memory = new MemoryStore(options.memoryDir);
    const sandbox = new FileSandbox(options.workspaceRoot);
    const browserManager = new PlaywrightBrowserManager(false);
    const allowedTools = ROUTE_TOOL_MAP[route];
    const task = buildExecutionTask(options.task, route, options.attachments ?? []);
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
        const tools = new Toolbox(sandbox, new ShellTool(sandbox.root), new BrowserTool(browserManager), allowedTools);
        const agentLoop = new AgentLoop(bridge, memory, tools, {
            availableTools: allowedTools,
            onEvent: options.onEvent
        });
        const result = await agentLoop.runTask(task, plan.steps);
        await options.onEvent?.({
            type: "task_completed",
            result
        });
        return result;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown task failure.";
        await options.onEvent?.({
            type: "task_failed",
            error: message
        });
        throw error;
    }
    finally {
        await bridge.close();
        await browserManager.close();
    }
}
export function getAllowedTools(route) {
    return ROUTE_TOOL_MAP[route];
}
export function getDefaultSessionWorkspace(sessionId) {
    return path.resolve(process.cwd(), "operator-data", "sessions", sessionId, "workspace");
}
export function getDefaultSessionMemory(sessionId) {
    return path.resolve(process.cwd(), "operator-data", "sessions", sessionId, "memory");
}
function buildExecutionTask(task, route, attachments) {
    const routeInstructions = route === "auto"
        ? "Execution route: auto. Use the available tools that best fit the task."
        : route === "local"
            ? "Execution route: local only. Do not rely on browser automation."
            : "Execution route: browser only. Do not rely on local filesystem or shell tools.";
    const attachmentBlock = attachments.length === 0
        ? "Attachments: none."
        : [
            "Attachments:",
            ...attachments.map((attachment, index) => `${index + 1}. ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes) at workspace path ${attachment.relativePath}`)
        ].join("\n");
    return [routeInstructions, attachmentBlock, "User request:", task].join("\n\n");
}
