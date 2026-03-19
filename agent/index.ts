import { createReasoningBridge } from "./bridge/factory.ts";
import { INITIAL_SYSTEM_PROMPT } from "./core/protocol.ts";
import { Planner } from "./core/planner.ts";
import { AgentLoop } from "./core/agent-loop.ts";
import { MemoryStore } from "./memory/store.ts";
import { BrowserTool } from "./tools/browser.ts";
import { FileSandbox } from "./tools/fs.ts";
import { PlaywrightBrowserManager } from "./tools/playwright-manager.ts";
import { ShellTool } from "./tools/shell.ts";
import { Toolbox } from "./tools/index.ts";

export async function runCli(argv: string[]): Promise<void> {
  const command = argv[0]?.trim();
  if (!command || command === "--help" || command === "-h") {
    console.log('Usage: node index.ts "task"');
    console.log('       node index.ts --login');
    return;
  }

  const bridge = createReasoningBridge();
  const memory = new MemoryStore();
  const sandbox = new FileSandbox();
  const browserManager = new PlaywrightBrowserManager(false);

  try {
    if (command === "--login") {
      await bridge.openLoginWindow();
      return;
    }

    const task = argv.join(" ").trim();
    await Promise.all([memory.initialize(), sandbox.initialize()]);
    await bridge.resetConversation();
    await bridge.prime(INITIAL_SYSTEM_PROMPT);

    const planner = new Planner(bridge);
    const plan = await planner.createPlan(task);

    const tools = new Toolbox(
      sandbox,
      new ShellTool(sandbox.root),
      new BrowserTool(browserManager)
    );
    const agentLoop = new AgentLoop(bridge, memory, tools);
    const result = await agentLoop.runTask(task, plan.steps);

    console.log(result);
  } finally {
    await bridge.close();
    await browserManager.close();
  }
}
