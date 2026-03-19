import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { limits } from "../config/limits.js";
import { withRetry } from "../resilience/retry.js";
import { clickNewChatIfAvailable, createSelectorCache, resolveComposer } from "./selectors.js";
import { waitForStableText } from "./stabilizer.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export class ChatGPTBridge {
    browser = null;
    context = null;
    page = null;
    options;
    selectorCache = createSelectorCache();
    primed = false;
    constructor(options = {}) {
        this.options = {
            chatgptUrl: options.chatgptUrl ?? process.env.CHATGPT_URL ?? "https://chat.openai.com",
            headless: parseBoolean(process.env.CHATGPT_HEADLESS, options.headless ?? false),
            storageStatePath: options.storageStatePath ??
                process.env.CHATGPT_STORAGE_STATE_PATH ??
                path.resolve(__dirname, "../.auth/chatgpt-storage.json")
        };
    }
    async initialize() {
        if (this.page) {
            return;
        }
        const storageState = await this.readStorageStateIfAvailable();
        this.browser = await chromium.launch({ headless: this.options.headless });
        this.context = await this.browser.newContext(storageState ? { storageState } : {});
        this.page = await this.context.newPage();
        await this.page.goto(this.options.chatgptUrl, { waitUntil: "domcontentloaded" });
        await clickNewChatIfAvailable(this.page, this.selectorCache);
        if (!storageState) {
            await this.captureStorageStateAfterManualLogin();
        }
    }
    async resetConversation() {
        const page = await this.getPage();
        await page.goto(this.options.chatgptUrl, { waitUntil: "domcontentloaded" });
        await clickNewChatIfAvailable(page, this.selectorCache);
        this.primed = false;
    }
    async prime(initialPrompt) {
        if (this.primed) {
            return;
        }
        await this.sendPrompt(initialPrompt);
        this.primed = true;
    }
    async ask(prompt) {
        return this.sendPrompt(prompt);
    }
    async getContext() {
        await this.initialize();
        if (!this.context) {
            throw new Error("Browser context is not available.");
        }
        return this.context;
    }
    async close() {
        await this.page?.close().catch(() => undefined);
        await this.context?.close().catch(() => undefined);
        await this.browser?.close().catch(() => undefined);
        this.page = null;
        this.context = null;
        this.browser = null;
        this.primed = false;
    }
    async sendPrompt(prompt) {
        const page = await this.getPage();
        const composer = await withRetry(async () => resolveComposer(page, this.selectorCache), { retries: limits.maxRetries, initialDelayMs: 500 });
        const previousAssistantText = await this.extractLatestAssistantText();
        await composer.click({ timeout: limits.selectorTimeoutMs });
        await composer.fill(prompt, { timeout: limits.selectorTimeoutMs });
        await composer.press("Enter");
        return waitForStableText(() => this.extractLatestAssistantText(), {
            mustDifferFrom: previousAssistantText
        });
    }
    async getPage() {
        await this.initialize();
        if (!this.page) {
            throw new Error("ChatGPT page is not initialized.");
        }
        return this.page;
    }
    async extractLatestAssistantText() {
        const page = await this.getPage();
        const text = (await page.evaluate(() => {
            const clean = (value) => value.replace(/\u200b/g, "").replace(/\s+\n/g, "\n").trim();
            const assistantMessages = Array.from(document.querySelectorAll("[data-message-author-role='assistant']"))
                .map((element) => clean(element.innerText || element.textContent || ""))
                .filter(Boolean);
            if (assistantMessages.length > 0) {
                return assistantMessages[assistantMessages.length - 1];
            }
            const main = document.querySelector("main");
            if (!main) {
                return "";
            }
            const articleTexts = Array.from(main.querySelectorAll("article"))
                .map((element) => clean(element.innerText || element.textContent || ""))
                .filter(Boolean);
            if (articleTexts.length > 0) {
                return articleTexts[articleTexts.length - 1];
            }
            return clean(main.innerText || "");
        }));
        return text.trim();
    }
    async captureStorageStateAfterManualLogin() {
        if (this.options.headless) {
            throw new Error(`Storage state not found at ${this.options.storageStatePath}. Run once with CHATGPT_HEADLESS=false to log in.`);
        }
        const page = await this.getPage();
        console.log("No ChatGPT storage state found. Log in in the opened browser window. Waiting for the message box...");
        await withRetry(async () => {
            await resolveComposer(page, this.selectorCache);
        }, {
            retries: Math.ceil(limits.loginWaitTimeoutMs / 5_000),
            initialDelayMs: 5_000
        });
        await fs.mkdir(path.dirname(this.options.storageStatePath), { recursive: true });
        await this.context?.storageState({ path: this.options.storageStatePath });
    }
    async readStorageStateIfAvailable() {
        try {
            await fs.access(this.options.storageStatePath);
            return this.options.storageStatePath;
        }
        catch {
            return undefined;
        }
    }
}
function parseBoolean(value, fallback) {
    if (value === undefined) {
        return fallback;
    }
    return value.toLowerCase() === "true";
}
