import { ClaudeApiBridge } from "./claude-api-bridge.ts";
import { ClaudeWebBridge } from "./claude-web-bridge.ts";
import { OpenAiApiBridge } from "./openai-api-bridge.ts";
import { ExtensionChatGPTBridge } from "./chatgpt-extension.ts";
import { ChatGPTBridge as PlaywrightChatGPTBridge } from "./chatgpt.ts";
import type { ReasoningBridge, ReasoningBridgeOptions } from "./types.ts";

/**
 * Available bridge modes:
 * - "api"         — OpenAI-compatible API (Groq/OpenRouter/OpenAI) — FAST, recommended
 * - "claude"      — Anthropic Messages API (requires API credits)
 * - "claude-web"  — automates claude.ai web UI via Playwright (free but slow)
 * - "playwright"  — ChatGPT via Playwright (free but slow)
 * - "extension"   — ChatGPT via Chrome extension bridge
 */
export function getBridgeMode(): string {
  return (process.env.MARSHAL_BRIDGE_MODE ?? "api").toLowerCase();
}

export function createReasoningBridge(options: ReasoningBridgeOptions = {}): ReasoningBridge {
  const mode = getBridgeMode();

  if (mode === "api") {
    return new OpenAiApiBridge(options);
  }
  if (mode === "claude") {
    return new ClaudeApiBridge(options);
  }
  if (mode === "claude-web") {
    return new ClaudeWebBridge(options);
  }
  if (mode === "playwright") {
    return new PlaywrightChatGPTBridge(options);
  }

  return new ExtensionChatGPTBridge(options);
}
