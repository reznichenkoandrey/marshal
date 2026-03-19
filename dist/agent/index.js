import { createReasoningBridge } from "./bridge/factory.js";
import { runMarshalTask } from "./runtime/marshal.js";
export async function runCli(argv) {
    const command = argv[0]?.trim();
    if (!command || command === "--help" || command === "-h") {
        console.log('Usage: node index.ts "task"');
        console.log('       node index.ts --login');
        return;
    }
    if (command === "--login") {
        const bridge = createReasoningBridge();
        try {
            await bridge.openLoginWindow();
        }
        finally {
            await bridge.close();
        }
        return;
    }
    try {
        const task = argv.join(" ").trim();
        const result = await runMarshalTask({ task });
        console.log(result);
    }
    catch (error) {
        throw error;
    }
}
