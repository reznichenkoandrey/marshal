import { ChatGPTBridge } from "./bridge/chatgpt.ts";
import { INITIAL_SYSTEM_PROMPT } from "./core/protocol.ts";
import { Planner } from "./core/planner.ts";
import { AgentLoop } from "./core/agent-loop.ts";
import { MemoryStore } from "./memory/store.ts";
import { BrowserTool } from "./tools/browser.ts";
import { FileSandbox } from "./tools/fs.ts";
import { ShellTool } from "./tools/shell.ts";
import { Toolbox } from "./tools/index.ts";

export async function runCli(argv: string[]): Promise<void> {
  const task = argv.join(" ").trim();
  if (!task || task === "--help" || task === "-h") {
    console.log('Usage: node index.ts "task"');
    return;
  }

  const bridge = new ChatGPTBridge();
  const memory = new MemoryStore();
  const sandbox = new FileSandbox();

  try {
    await Promise.all([memory.initialize(), sandbox.initialize()]);
    await bridge.resetConversation();
    await bridge.prime(INITIAL_SYSTEM_PROMPT);

    const planner = new Planner(bridge);
    const plan = await planner.createPlan(task);

    const tools = new Toolbox(sandbox, new ShellTool(sandbox.root), new BrowserTool(bridge));
    const agentLoop = new AgentLoop(bridge, memory, tools);
    const result = await agentLoop.runTask(task, plan.steps);

    console.log(result);
  } finally {
    await bridge.close();
  }
}
