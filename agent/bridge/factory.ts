import { ClaudeApiBridge } from "./claude-api-bridge.ts";
import { ClaudeCliBridge } from "./claude-cli-bridge.ts";
import { ClaudeWebBridge } from "./claude-web-bridge.ts";
import { CodexCliBridge } from "./codex-cli-bridge.ts";
import { OpenAiApiBridge } from "./openai-api-bridge.ts";
import { ExtensionChatGPTBridge } from "./chatgpt-extension.ts";
import { ChatGPTBridge as PlaywrightChatGPTBridge } from "./chatgpt.ts";
import type { ReasoningBridge, ReasoningBridgeOptions } from "./types.ts";

/**
 * Available bridge modes:
 * - "claude-cli"  — local `claude` CLI, billed to Claude Pro/Max subscription (DEFAULT)
 * - "codex-cli"   — local `codex` CLI, billed to ChatGPT Plus/Pro subscription
 * - "claude"      — Anthropic Messages API (requires API credits)
 * - "api"         — OpenAI-compatible API (Groq/OpenRouter/OpenAI)
 * - "claude-web"  — automates claude.ai web UI via Playwright
 * - "playwright"  — ChatGPT via Playwright
 * - "extension"   — ChatGPT via Chrome extension bridge
 */
export function getBridgeMode(): string {
  return (process.env.MARSHAL_BRIDGE_MODE ?? "claude-cli").toLowerCase();
}

export function createReasoningBridge(options: ReasoningBridgeOptions = {}): ReasoningBridge {
  const mode = getBridgeMode();

  if (mode === "claude-cli") {
    return new ClaudeCliBridge(options);
  }
  if (mode === "codex-cli") {
    return new CodexCliBridge(options);
  }
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
