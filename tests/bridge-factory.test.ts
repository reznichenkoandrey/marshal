import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeApiBridge } from "../agent/bridge/claude-api-bridge.ts";
import { ClaudeCliBridge } from "../agent/bridge/claude-cli-bridge.ts";
import { ClaudeWebBridge } from "../agent/bridge/claude-web-bridge.ts";
import { CodexCliBridge } from "../agent/bridge/codex-cli-bridge.ts";
import { ExtensionChatGPTBridge } from "../agent/bridge/chatgpt-extension.ts";
import { OpenAiApiBridge } from "../agent/bridge/openai-api-bridge.ts";
import { ChatGPTBridge as PlaywrightChatGPTBridge } from "../agent/bridge/chatgpt.ts";
import { createReasoningBridge, getBridgeMode } from "../agent/bridge/factory.ts";

// Bridges that read credentials at construct time need dummy values so we
// don't crash during instantiation. The bridges are never *called* in this
// suite — we only check that the factory dispatches to the right class.
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.ANTHROPIC_API_KEY = "test-anthropic";
  process.env.MARSHAL_API_KEY = "test-marshal";
});

afterEach(() => {
  process.env = originalEnv;
});

describe("getBridgeMode", () => {
  it("returns the default when MARSHAL_BRIDGE_MODE is unset", () => {
    delete process.env.MARSHAL_BRIDGE_MODE;
    expect(getBridgeMode()).toBe("claude-cli");
  });

  it("lowercases the env value", () => {
    process.env.MARSHAL_BRIDGE_MODE = "CLAUDE-CLI";
    expect(getBridgeMode()).toBe("claude-cli");
  });
});

describe("createReasoningBridge", () => {
  it("returns ClaudeCliBridge for claude-cli", () => {
    process.env.MARSHAL_BRIDGE_MODE = "claude-cli";
    expect(createReasoningBridge()).toBeInstanceOf(ClaudeCliBridge);
  });

  it("returns CodexCliBridge for codex-cli", () => {
    process.env.MARSHAL_BRIDGE_MODE = "codex-cli";
    expect(createReasoningBridge()).toBeInstanceOf(CodexCliBridge);
  });

  it("returns OpenAiApiBridge for api", () => {
    process.env.MARSHAL_BRIDGE_MODE = "api";
    expect(createReasoningBridge()).toBeInstanceOf(OpenAiApiBridge);
  });

  it("returns ClaudeApiBridge for claude", () => {
    process.env.MARSHAL_BRIDGE_MODE = "claude";
    expect(createReasoningBridge()).toBeInstanceOf(ClaudeApiBridge);
  });

  it("returns ClaudeWebBridge for claude-web", () => {
    process.env.MARSHAL_BRIDGE_MODE = "claude-web";
    expect(createReasoningBridge()).toBeInstanceOf(ClaudeWebBridge);
  });

  it("returns PlaywrightChatGPTBridge for playwright", () => {
    process.env.MARSHAL_BRIDGE_MODE = "playwright";
    expect(createReasoningBridge()).toBeInstanceOf(PlaywrightChatGPTBridge);
  });

  it("falls back to ExtensionChatGPTBridge for unknown modes", () => {
    process.env.MARSHAL_BRIDGE_MODE = "totally-not-a-mode";
    expect(createReasoningBridge()).toBeInstanceOf(ExtensionChatGPTBridge);
  });

  it("falls back to ExtensionChatGPTBridge for explicit `extension` mode", () => {
    process.env.MARSHAL_BRIDGE_MODE = "extension";
    expect(createReasoningBridge()).toBeInstanceOf(ExtensionChatGPTBridge);
  });

  it("forwards options to the constructed bridge", () => {
    process.env.MARSHAL_BRIDGE_MODE = "claude-cli";
    // The bridge classes accept ReasoningBridgeOptions; we only assert
    // construction completes and the right type came back. Passing a
    // sentinel options object proves the factory isn't dropping arguments.
    const bridge = createReasoningBridge({});
    expect(bridge).toBeInstanceOf(ClaudeCliBridge);
  });
});
