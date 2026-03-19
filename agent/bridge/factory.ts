import { ExtensionChatGPTBridge } from "./chatgpt-extension.ts";
import { ChatGPTBridge as PlaywrightChatGPTBridge } from "./chatgpt.ts";
import type { ReasoningBridge } from "./types.ts";

export function createReasoningBridge(): ReasoningBridge {
  const mode = (process.env.CHATGPT_BRIDGE_MODE ?? "extension").toLowerCase();
  if (mode === "playwright") {
    return new PlaywrightChatGPTBridge();
  }

  return new ExtensionChatGPTBridge();
}
