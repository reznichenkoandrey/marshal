import { getSharedLocalBridgeServer, LocalBridgeServer } from "./local-bridge-server.ts";
import type { ReasoningBridge, ReasoningBridgeOptions } from "./types.ts";

export class ExtensionChatGPTBridge implements ReasoningBridge {
  server: LocalBridgeServer;
  primed = false;
  projectName: string | null;
  targetSessionKey: string | null;

  constructor(options: ReasoningBridgeOptions = {}, server = getSharedLocalBridgeServer()) {
    this.server = server;
    this.projectName = options.projectName?.trim() || process.env.CHATGPT_PROJECT_NAME?.trim() || null;
    this.targetSessionKey = null;
  }

  async initialize(): Promise<void> {
    await this.server.start();
  }

  async openLoginWindow(): Promise<void> {
    await this.initialize();
    console.log("Extension bridge server is running.");
    console.log("1. Load the unpacked extension from dist/chrome-extension in your normal Chrome.");
    console.log("2. Open chatgpt.com in that Chrome session and log in there.");
    console.log(`3. Keep the ChatGPT tab open. The local bridge listens on http://127.0.0.1:${this.server.port}.`);
    this.targetSessionKey = (await this.server.waitForReadyClient(24 * 60 * 60 * 1000)).sessionKey;
  }

  async resetConversation(): Promise<void> {
    await this.initialize();
    await this.ensureTargetSession();
    const result = await this.server.sendCommand(
      "reset_conversation",
      this.getProjectPayload(),
      90_000,
      this.targetSessionKey
    );
    if (!result.ok) {
      throw new Error(result.error ?? "Extension failed to reset the ChatGPT conversation.");
    }
  }

  async prime(initialPrompt: string): Promise<void> {
    if (this.primed) {
      return;
    }

    await this.initialize();
    await this.ensureTargetSession();
    const result = await this.server.sendCommand(
      "send_prompt",
      {
        prompt: initialPrompt,
        responseMode: "ready_surface",
        ...this.getProjectPayload()
      },
      180_000,
      this.targetSessionKey
    );
    if (!result.ok) {
      throw new Error(result.error ?? "Extension failed to prime the ChatGPT conversation.");
    }

    this.primed = true;
  }

  async ask(prompt: string): Promise<string> {
    await this.initialize();
    await this.ensureTargetSession();
    const result = await this.server.sendCommand(
      "send_prompt",
      {
        prompt,
        ...this.getProjectPayload()
      },
      90_000,
      this.targetSessionKey
    );
    if (!result.ok) {
      throw new Error(result.error ?? "Extension failed to send the prompt to ChatGPT.");
    }

    const responseText = String(result.data?.responseText ?? "");
    if (!responseText.trim()) {
      throw new Error("Extension returned an empty ChatGPT response.");
    }

    return responseText;
  }

  async close(): Promise<void> {
    await this.server.close();
    this.primed = false;
    this.targetSessionKey = null;
  }

  private getProjectPayload(): Record<string, unknown> {
    return this.projectName ? { projectName: this.projectName } : {};
  }

  private async ensureTargetSession(): Promise<void> {
    if (this.targetSessionKey) {
      return;
    }

    this.targetSessionKey = (await this.server.waitForReadyClient()).sessionKey;
  }
}
