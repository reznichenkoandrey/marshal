import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { limits } from "../config/limits.js";
import { withRetry } from "../resilience/retry.js";
import { clickNewChatIfAvailable, createSelectorCache, resolveComposer } from "./selectors.js";
import { waitForStableText } from "./stabilizer.js";
export class ChatGPTBridge {
    browser = null;
    context = null;
    page = null;
    options;
    selectorCache = createSelectorCache();
    primed = false;
    connectionMode = "launched";
    constructor(options = {}) {
        this.options = {
            chatgptUrl: options.chatgptUrl ?? process.env.CHATGPT_URL ?? "https://chatgpt.com",
            headless: parseBoolean(process.env.CHATGPT_HEADLESS, options.headless ?? false),
            storageStatePath: options.storageStatePath ??
                process.env.CHATGPT_STORAGE_STATE_PATH ??
                path.resolve(process.cwd(), "agent/.auth/chatgpt-storage.json"),
            userDataDir: process.env.CHATGPT_USER_DATA_DIR ?? path.resolve(process.cwd(), "agent/.chrome-profile"),
            executablePath: resolveChromeExecutable(process.env.CHATGPT_BROWSER_EXECUTABLE_PATH ?? undefined),
            cdpUrl: process.env.CHATGPT_CDP_URL ?? undefined,
            projectName: options.projectName?.trim() || process.env.CHATGPT_PROJECT_NAME?.trim() || undefined
        };
    }
    async initialize() {
        if (this.page) {
            return;
        }
        if (this.options.cdpUrl) {
            await this.attachToExistingBrowser();
            return;
        }
        const storageState = await this.readStorageStateIfAvailable();
        this.context = await this.launchContext(storageState);
        this.page = this.context.pages()[0] ?? (await this.context.newPage());
        await this.page.goto(this.options.chatgptUrl, { waitUntil: "domcontentloaded" });
        await this.waitForChatGPTSurface();
        await this.ensureProjectSelected();
        await clickNewChatIfAvailable(this.page, this.selectorCache);
        if (!storageState) {
            await this.captureStorageStateAfterManualLogin();
        }
    }
    async openLoginWindow() {
        if (this.options.cdpUrl) {
            throw new Error("CHATGPT_CDP_URL is set. Start the manual browser with open-chatgpt-browser.sh and log in there.");
        }
        if (!this.page) {
            this.context = await this.launchContext(undefined);
            this.page = this.context.pages()[0] ?? (await this.context.newPage());
        }
        await this.page.goto(this.options.chatgptUrl, { waitUntil: "domcontentloaded" });
        await this.waitForChatGPTSurface();
        console.log("Chrome login window is open. Log in to ChatGPT there. Keep this process running while you authenticate.");
        await new Promise(() => {
            // Keep the Chrome profile alive until the process is interrupted.
        });
    }
    async resetConversation() {
        const page = await this.getPage();
        await page.goto(this.options.chatgptUrl, { waitUntil: "domcontentloaded" });
        await this.waitForChatGPTSurface();
        await this.ensureProjectSelected();
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
        if (this.connectionMode === "cdp") {
            this.page = null;
            this.context = null;
            this.browser = null;
            this.primed = false;
            return;
        }
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
        await this.ensureProjectSelected();
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
    async ensureProjectSelected() {
        const projectName = this.options.projectName?.trim();
        if (!projectName) {
            return;
        }
        const page = await this.getPage();
        const alreadySelected = await page.evaluate((targetName) => {
            const normalizedTarget = normalizeComparableText(targetName);
            const candidates = Array.from(document.querySelectorAll("main h1, main h2, nav a, nav button, aside a, aside button"));
            return candidates.some((element) => {
                if (!isDomElementVisible(element)) {
                    return false;
                }
                const text = normalizeComparableText([element.textContent ?? "", element.getAttribute("aria-label") ?? ""].join(" "));
                return text === normalizedTarget && element.getAttribute("aria-current") === "page";
            });
            function normalizeComparableText(value) {
                return value.replace(/\s+/g, " ").trim().toLowerCase();
            }
            function isDomElementVisible(element) {
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
            }
        }, projectName);
        if (alreadySelected) {
            return;
        }
        await expandProjectsSectionIfPresent(page);
        const clicked = await page.evaluate((targetName) => {
            const normalizedTarget = normalizeComparableText(targetName);
            const candidates = Array.from(document.querySelectorAll("a,button,[role='button']"));
            const match = candidates.find((element) => {
                if (!isDomElementVisible(element)) {
                    return false;
                }
                const text = normalizeComparableText([
                    element.textContent ?? "",
                    element.getAttribute("aria-label") ?? "",
                    element.getAttribute("title") ?? ""
                ].join(" "));
                if (text !== normalizedTarget) {
                    return false;
                }
                return Boolean(element.closest("nav, aside, [data-testid*='sidebar'], [class*='sidebar']"));
            });
            if (!match) {
                return false;
            }
            match.click();
            return true;
            function normalizeComparableText(value) {
                return value.replace(/\s+/g, " ").trim().toLowerCase();
            }
            function isDomElementVisible(element) {
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
            }
        }, projectName);
        if (!clicked) {
            throw new Error(`ChatGPT project "${projectName}" was not found in the sidebar.`);
        }
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.waitForTimeout(800);
        await this.waitForAuthenticatedPromptReadiness();
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
    async launchContext(_storageState) {
        await fs.mkdir(this.options.userDataDir, { recursive: true });
        const launchOptions = {
            headless: this.options.headless,
            viewport: { width: 1440, height: 1000 },
            args: ["--start-maximized"]
        };
        if (this.options.executablePath) {
            launchOptions.executablePath = this.options.executablePath;
        }
        else {
            launchOptions.channel = "chrome";
        }
        return chromium.launchPersistentContext(this.options.userDataDir, launchOptions);
    }
    async attachToExistingBrowser() {
        if (!this.options.cdpUrl) {
            throw new Error("CHATGPT_CDP_URL is not configured.");
        }
        this.connectionMode = "cdp";
        this.browser = await chromium.connectOverCDP(this.options.cdpUrl);
        this.context = this.browser.contexts()[0];
        if (!this.context) {
            throw new Error(`Connected to ${this.options.cdpUrl}, but no default browser context was available.`);
        }
        const existingChatPage = this.context
            .pages()
            .find((candidate) => /chatgpt\.com|chat\.openai\.com/.test(candidate.url()));
        this.page = existingChatPage ?? (await this.context.newPage());
        await this.page.goto(this.options.chatgptUrl, { waitUntil: "domcontentloaded" });
        await this.waitForChatGPTSurface();
        await this.ensureProjectSelected();
    }
}
async function expandProjectsSectionIfPresent(page) {
    const toggle = page
        .locator("button,[role='button']")
        .filter({ hasText: /projects|проекти|проєкти/i })
        .first();
    if (!(await toggle.isVisible().catch(() => false))) {
        return;
    }
    const expanded = await toggle.getAttribute("aria-expanded").catch(() => null);
    if (expanded === "false") {
        await toggle.click({ timeout: limits.selectorTimeoutMs }).catch(() => undefined);
        await page.waitForTimeout(400);
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
    const loginCount = (await countVisible(page.getByRole("button", { name: /log in|sign in|увійти/i }), 4)) +
        (await countVisible(page.getByRole("link", { name: /log in|sign in|увійти/i }), 4));
    const signupCount = (await countVisible(page.getByRole("button", { name: /sign up|зареєструватися/i }), 4)) +
        (await countVisible(page.getByRole("link", { name: /sign up|зареєструватися/i }), 4));
    return loginCount > 0 && signupCount > 0;
}
async function countVisible(locator, limit) {
    const total = Math.min(await locator.count(), limit);
    let visible = 0;
    for (let index = 0; index < total; index += 1) {
        try {
            if (await locator.nth(index).isVisible()) {
                visible += 1;
            }
        }
        catch {
            continue;
        }
    }
    return visible;
}
function resolveChromeExecutable(explicitPath) {
    const candidates = [
        explicitPath,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
    ].filter((value) => Boolean(value));
    return candidates.find((candidate) => fsSync.existsSync(candidate));
}
