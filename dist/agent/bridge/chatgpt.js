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
        await this.waitForChatGPTSurface();
        await clickNewChatIfAvailable(this.page, this.selectorCache);
        if (!storageState) {
            await this.captureStorageStateAfterManualLogin();
        }
    }
    async resetConversation() {
        const page = await this.getPage();
        await page.goto(this.options.chatgptUrl, { waitUntil: "domcontentloaded" });
        await this.waitForChatGPTSurface();
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
        await this.ensureReadyForPrompt();
        const composer = await withRetry(async () => resolveComposer(page, this.selectorCache), { retries: limits.maxRetries, initialDelayMs: 500 });
        const previousAssistantText = await this.extractLatestAssistantText();
        await composer.click({ timeout: limits.selectorTimeoutMs });
        await composer.fill(prompt, { timeout: limits.selectorTimeoutMs }).catch(async () => {
            await composer.press("Control+A").catch(() => undefined);
            await composer.press("Meta+A").catch(() => undefined);
            await composer.type(prompt, { timeout: limits.selectorTimeoutMs });
        });
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
        console.log("No ChatGPT storage state found. Log in in the opened browser window. Waiting for an authenticated ChatGPT page...");
        await withRetry(async () => {
            await this.waitForAuthenticatedPromptReadiness();
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
    async waitForChatGPTSurface() {
        const page = await this.getPage();
        await page.waitForLoadState("domcontentloaded");
        await page.waitForURL(/chatgpt\.com|chat\.openai\.com|auth\.openai\.com|accounts\.google\.com/, {
            timeout: limits.toolPageTimeoutMs
        });
    }
    async ensureReadyForPrompt() {
        const page = await this.getPage();
        await this.waitForChatGPTSurface();
        if (await isExternalAuthPage(page)) {
            throw new Error("ChatGPT is currently on an external authentication page. Complete login and return to ChatGPT.");
        }
        if (await isLoggedOutHomepage(page)) {
            throw new Error("ChatGPT is showing the logged-out homepage. Complete login to reuse a real session.");
        }
    }
    async waitForAuthenticatedPromptReadiness() {
        const page = await this.getPage();
        await this.waitForChatGPTSurface();
        if (await isExternalAuthPage(page)) {
            throw new Error("Still waiting for ChatGPT to return from the external authentication page.");
        }
        if (await isLoggedOutHomepage(page)) {
            throw new Error("Still on the logged-out ChatGPT homepage.");
        }
        await resolveComposer(page, this.selectorCache);
    }
}
function parseBoolean(value, fallback) {
    if (value === undefined) {
        return fallback;
    }
    return value.toLowerCase() === "true";
}
async function isExternalAuthPage(page) {
    const url = page.url();
    return /accounts\.google\.com|auth\.openai\.com/.test(url);
}
async function isLoggedOutHomepage(page) {
    if (await isExternalAuthPage(page)) {
        return false;
    }
    const loginCount = (await page.getByRole("button", { name: /log in|sign in|увійти/i }).count()) +
        (await page.getByRole("link", { name: /log in|sign in|увійти/i }).count());
    const signupCount = (await page.getByRole("button", { name: /sign up|зареєструватися/i }).count()) +
        (await page.getByRole("link", { name: /sign up|зареєструватися/i }).count());
    return loginCount > 0 && signupCount > 0;
}
