import { createReasoningBridge } from "./bridge/factory.ts";
import { runMarshalTask } from "./runtime/marshal.ts";

export async function runCli(argv: string[]): Promise<void> {
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
    } finally {
      await bridge.close();
    }
    return;
  }

  try {
    const task = argv.join(" ").trim();
    const result = await runMarshalTask({ task });
    console.log(result);
  } catch (error) {
    throw error;
  }
}
