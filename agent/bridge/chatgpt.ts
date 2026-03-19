import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import { limits } from "../config/limits.ts";
import { withRetry } from "../resilience/retry.ts";
import { clickNewChatIfAvailable, createSelectorCache, resolveComposer } from "./selectors.ts";
import { waitForStableText } from "./stabilizer.ts";

type BridgeOptions = {
  chatgptUrl: string;
  headless: boolean;
  storageStatePath: string;
  userDataDir: string;
  executablePath?: string;
  cdpUrl?: string;
  projectName?: string;
};

export class ChatGPTBridge {
  browser: Browser | null = null;
  context: BrowserContext | null = null;
  page: Page | null = null;
  options: BridgeOptions;
  selectorCache = createSelectorCache();
  primed = false;
  connectionMode: "launched" | "cdp" = "launched";

  constructor(options: Partial<BridgeOptions> = {}) {
    this.options = {
      chatgptUrl: options.chatgptUrl ?? process.env.CHATGPT_URL ?? "https://chatgpt.com",
      headless: parseBoolean(process.env.CHATGPT_HEADLESS, options.headless ?? false),
      storageStatePath:
        options.storageStatePath ??
        process.env.CHATGPT_STORAGE_STATE_PATH ??
        path.resolve(process.cwd(), "agent/.auth/chatgpt-storage.json"),
      userDataDir:
        process.env.CHATGPT_USER_DATA_DIR ?? path.resolve(process.cwd(), "agent/.chrome-profile"),
      executablePath: resolveChromeExecutable(
        process.env.CHATGPT_BROWSER_EXECUTABLE_PATH ?? undefined
      ),
      cdpUrl: process.env.CHATGPT_CDP_URL ?? undefined,
      projectName: options.projectName?.trim() || process.env.CHATGPT_PROJECT_NAME?.trim() || undefined
    };
  }

  async initialize(): Promise<void> {
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

  async openLoginWindow(): Promise<void> {
    if (this.options.cdpUrl) {
      throw new Error(
        "CHATGPT_CDP_URL is set. Start the manual browser with open-chatgpt-browser.sh and log in there."
      );
    }

    if (!this.page) {
      this.context = await this.launchContext(undefined);
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
    }

    await this.page.goto(this.options.chatgptUrl, { waitUntil: "domcontentloaded" });
    await this.waitForChatGPTSurface();
    console.log("Chrome login window is open. Log in to ChatGPT there. Keep this process running while you authenticate.");

    await new Promise<void>(() => {
      // Keep the Chrome profile alive until the process is interrupted.
    });
  }

  async resetConversation(): Promise<void> {
    const page = await this.getPage();
    await page.goto(this.options.chatgptUrl, { waitUntil: "domcontentloaded" });
    await this.waitForChatGPTSurface();
    await this.ensureProjectSelected();
    await clickNewChatIfAvailable(page, this.selectorCache);
    this.primed = false;
  }

  async prime(initialPrompt: string): Promise<void> {
    if (this.primed) {
      return;
    }

    await this.sendPrompt(initialPrompt);
    this.primed = true;
  }

  async ask(prompt: string): Promise<string> {
    return this.sendPrompt(prompt);
  }

  async getContext(): Promise<BrowserContext> {
    await this.initialize();
    if (!this.context) {
      throw new Error("Browser context is not available.");
    }

    return this.context;
  }

  async close(): Promise<void> {
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

  private async sendPrompt(prompt: string): Promise<string> {
    const page = await this.getPage();
    await this.ensureReadyForPrompt();
    await this.ensureProjectSelected();
    const composer = await withRetry(
      async () => resolveComposer(page, this.selectorCache),
      { retries: limits.maxRetries, initialDelayMs: 500 }
    );

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

  private async getPage(): Promise<Page> {
    await this.initialize();
    if (!this.page) {
      throw new Error("ChatGPT page is not initialized.");
    }

    return this.page;
  }

  private async extractLatestAssistantText(): Promise<string> {
    const page = await this.getPage();
    const text = (await page.evaluate(() => {
      const clean = (value: string) => value.replace(/\u200b/g, "").replace(/\s+\n/g, "\n").replace(/\s+/g, " ").trim();
      const isVisible = (element: Element) => {
        const node = element as HTMLElement;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const getVisibleTexts = (root: ParentNode | null, selector: string) => {
        if (!root) {
          return [];
        }

        return Array.from(root.querySelectorAll(selector))
          .filter((element) => isVisible(element))
          .map((element) => clean((element as HTMLElement).innerText || element.textContent || ""))
          .filter(Boolean);
      };
      const main = document.querySelector("main");
      const assistantMessages = getVisibleTexts(main, "[data-message-author-role='assistant']");

      if (assistantMessages.length > 0) {
        return assistantMessages[assistantMessages.length - 1];
      }

      if (!main) {
        return "";
      }

      const articleTexts = getVisibleTexts(main, "article");

      if (articleTexts.length > 0) {
        return articleTexts[articleTexts.length - 1];
      }

      return clean((main as HTMLElement).innerText || "");
    })) as string;

    return text.trim();
  }

  private async captureStorageStateAfterManualLogin(): Promise<void> {
    if (this.options.headless) {
      throw new Error(
        `Storage state not found at ${this.options.storageStatePath}. Run once with CHATGPT_HEADLESS=false to log in.`
      );
    }

    console.log(
      "No ChatGPT storage state found. Log in in the opened browser window. Waiting for an authenticated ChatGPT page..."
    );
    await withRetry(
      async () => {
        await this.waitForAuthenticatedPromptReadiness();
      },
      {
        retries: Math.ceil(limits.loginWaitTimeoutMs / 5_000),
        initialDelayMs: 5_000
      }
    );

    await fs.mkdir(path.dirname(this.options.storageStatePath), { recursive: true });
    await this.context?.storageState({ path: this.options.storageStatePath });
  }

  private async readStorageStateIfAvailable(): Promise<string | undefined> {
    try {
      await fs.access(this.options.storageStatePath);
      return this.options.storageStatePath;
    } catch {
      return undefined;
    }
  }

  private async waitForChatGPTSurface(): Promise<void> {
    const page = await this.getPage();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForURL(/chatgpt\.com|chat\.openai\.com|auth\.openai\.com|accounts\.google\.com/, {
      timeout: limits.toolPageTimeoutMs
    });
  }

  private async ensureReadyForPrompt(): Promise<void> {
    const page = await this.getPage();
    await this.waitForChatGPTSurface();

    if (await isExternalAuthPage(page)) {
      throw new Error("ChatGPT is currently on an external authentication page. Complete login and return to ChatGPT.");
    }

    if (await isLoggedOutHomepage(page)) {
      throw new Error("ChatGPT is showing the logged-out homepage. Complete login to reuse a real session.");
    }
  }

  private async ensureProjectSelected(): Promise<void> {
    const projectName = this.options.projectName?.trim();
    if (!projectName) {
      return;
    }

    const page = await this.getPage();
    const alreadySelected = await page.evaluate((targetName) => {
      const normalizedTarget = normalizeComparableText(targetName);
      const candidates = Array.from(
        document.querySelectorAll("main h1, main h2, nav a, nav button, aside a, aside button")
      ) as HTMLElement[];

      return candidates.some((element) => {
        if (!isDomElementVisible(element)) {
          return false;
        }

        const text = normalizeComparableText(
          [element.textContent ?? "", element.getAttribute("aria-label") ?? ""].join(" ")
        );
        return text === normalizedTarget && element.getAttribute("aria-current") === "page";
      });

      function normalizeComparableText(value: string): string {
        return value.replace(/\s+/g, " ").trim().toLowerCase();
      }

      function isDomElementVisible(element: HTMLElement): boolean {
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
      const candidates = Array.from(document.querySelectorAll("a,button,[role='button']")) as HTMLElement[];

      const match = candidates.find((element) => {
        if (!isDomElementVisible(element)) {
          return false;
        }

        const text = normalizeComparableText(
          [
            element.textContent ?? "",
            element.getAttribute("aria-label") ?? "",
            element.getAttribute("title") ?? ""
          ].join(" ")
        );

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

      function normalizeComparableText(value: string): string {
        return value.replace(/\s+/g, " ").trim().toLowerCase();
      }

      function isDomElementVisible(element: HTMLElement): boolean {
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

  private async waitForAuthenticatedPromptReadiness(): Promise<void> {
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

  private async launchContext(_storageState: string | undefined): Promise<BrowserContext> {
    await fs.mkdir(this.options.userDataDir, { recursive: true });

    const launchOptions: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]> = {
      headless: this.options.headless,
      viewport: { width: 1440, height: 1000 },
      args: ["--start-maximized"]
    };

    if (this.options.executablePath) {
      launchOptions.executablePath = this.options.executablePath;
    } else {
      launchOptions.channel = "chrome";
    }

    return chromium.launchPersistentContext(this.options.userDataDir, launchOptions);
  }

  private async attachToExistingBrowser(): Promise<void> {
    if (!this.options.cdpUrl) {
      throw new Error("CHATGPT_CDP_URL is not configured.");
    }

    this.connectionMode = "cdp";
    this.browser = await chromium.connectOverCDP(this.options.cdpUrl);
    this.context = this.browser.contexts()[0];
    if (!this.context) {
      throw new Error(
        `Connected to ${this.options.cdpUrl}, but no default browser context was available.`
      );
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

async function expandProjectsSectionIfPresent(page: Page): Promise<void> {
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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value.toLowerCase() === "true";
}

async function isExternalAuthPage(page: Page): Promise<boolean> {
  const url = page.url();
  return /accounts\.google\.com|auth\.openai\.com/.test(url);
}

async function isLoggedOutHomepage(page: Page): Promise<boolean> {
  if (await isExternalAuthPage(page)) {
    return false;
  }

  const loginCount =
    (await countVisible(page.getByRole("button", { name: /log in|sign in|увійти/i }), 4)) +
    (await countVisible(page.getByRole("link", { name: /log in|sign in|увійти/i }), 4));

  const signupCount =
    (await countVisible(page.getByRole("button", { name: /sign up|зареєструватися/i }), 4)) +
    (await countVisible(page.getByRole("link", { name: /sign up|зареєструватися/i }), 4));

  return loginCount > 0 && signupCount > 0;
}

async function countVisible(locator: ReturnType<Page["getByRole"]>, limit: number): Promise<number> {
  const total = Math.min(await locator.count(), limit);
  let visible = 0;

  for (let index = 0; index < total; index += 1) {
    try {
      if (await locator.nth(index).isVisible()) {
        visible += 1;
      }
    } catch {
      continue;
    }
  }

  return visible;
}

function resolveChromeExecutable(explicitPath?: string): string | undefined {
  const candidates = [
    explicitPath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => fsSync.existsSync(candidate));
}
