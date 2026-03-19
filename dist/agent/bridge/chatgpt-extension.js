import { LocalBridgeServer } from "./local-bridge-server.js";
export class ExtensionChatGPTBridge {
    server;
    primed = false;
    projectName;
    constructor(options = {}, server = new LocalBridgeServer()) {
        this.server = server;
        this.projectName = options.projectName?.trim() || process.env.CHATGPT_PROJECT_NAME?.trim() || null;
    }
    async initialize() {
        await this.server.start();
    }
    async openLoginWindow() {
        await this.initialize();
        console.log("Extension bridge server is running.");
        console.log("1. Load the unpacked extension from dist/chrome-extension in your normal Chrome.");
        console.log("2. Open chatgpt.com in that Chrome session and log in there.");
        console.log(`3. Keep the ChatGPT tab open. The local bridge listens on http://127.0.0.1:${this.server.port}.`);
        await this.server.waitForReadyClient(24 * 60 * 60 * 1000);
    }
    async resetConversation() {
        await this.initialize();
        const result = await this.server.sendCommand("reset_conversation", this.getProjectPayload());
        if (!result.ok) {
            throw new Error(result.error ?? "Extension failed to reset the ChatGPT conversation.");
        }
    }
    async prime(initialPrompt) {
        if (this.primed) {
            return;
        }
        await this.ask(initialPrompt);
        this.primed = true;
    }
    async ask(prompt) {
        await this.initialize();
        const result = await this.server.sendCommand("send_prompt", {
            prompt,
            ...this.getProjectPayload()
        });
        if (!result.ok) {
            throw new Error(result.error ?? "Extension failed to send the prompt to ChatGPT.");
        }
        const responseText = String(result.data?.responseText ?? "");
        if (!responseText.trim()) {
            throw new Error("Extension returned an empty ChatGPT response.");
        }
        return responseText;
    }
    async close() {
        await this.server.close();
        this.primed = false;
    }
    getProjectPayload() {
        return this.projectName ? { projectName: this.projectName } : {};
    }
}
