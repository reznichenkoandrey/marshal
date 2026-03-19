import { ChatGPTBridge } from "./bridge/chatgpt.js";
import { INITIAL_SYSTEM_PROMPT } from "./core/protocol.js";
import { Planner } from "./core/planner.js";
import { AgentLoop } from "./core/agent-loop.js";
import { MemoryStore } from "./memory/store.js";
import { BrowserTool } from "./tools/browser.js";
import { FileSandbox } from "./tools/fs.js";
import { ShellTool } from "./tools/shell.js";
import { Toolbox } from "./tools/index.js";
export async function runCli(argv) {
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
    }
    finally {
        await bridge.close();
    }
}
