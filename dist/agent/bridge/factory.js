import { ExtensionChatGPTBridge } from "./chatgpt-extension.js";
import { ChatGPTBridge as PlaywrightChatGPTBridge } from "./chatgpt.js";
export function createReasoningBridge() {
    const mode = (process.env.CHATGPT_BRIDGE_MODE ?? "extension").toLowerCase();
    if (mode === "playwright") {
        return new PlaywrightChatGPTBridge();
    }
    return new ExtensionChatGPTBridge();
}
