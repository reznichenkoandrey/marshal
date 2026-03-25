import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { chromium } from "playwright";
import type { BrowserContext, Locator, Page } from "playwright";

import { limits } from "../config/limits.ts";
import { withRetry } from "../resilience/retry.ts";
import { waitForStableText } from "./stabilizer.ts";
import type { ReasoningBridge, ReasoningBridgeOptions } from "./types.ts";

type ClaudeWebOptions = {
  claudeUrl: string;
  headless: boolean;
  userDataDir: string;
  executablePath?: string;
};

/**
 * Bridge that automates claude.ai web UI via Playwright.
 * Uses a dedicated persistent Chrome profile with the real Chrome binary.
 * First launch: user must pass Cloudflare + log in manually (cookies persist).
 * Subsequent launches: cookies are saved, auto-logged-in.
 * Free with Max plan — no API credits required.
 */
export class ClaudeWebBridge implements ReasoningBridge {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private options: ClaudeWebOptions;
  private primed = false;

  constructor(_options: ReasoningBridgeOptions = {}) {
    this.options = {
      claudeUrl: process.env.CLAUDE_WEB_URL ?? "https://claude.ai/new",
      headless: (process.env.CLAUDE_WEB_HEADLESS ?? "false").toLowerCase() === "true",
      userDataDir:
        process.env.CLAUDE_WEB_USER_DATA_DIR ??
        path.resolve(process.cwd(), "agent/.claude-web-profile"),
      executablePath: resolveChromeExecutable(
        process.env.CLAUDE_WEB_BROWSER_PATH ?? undefined
      )
    };
  }

  async initialize(): Promise<void> {
    if (this.page) {
      return;
    }

    await fs.mkdir(this.options.userDataDir, { recursive: true });

    // Launch real Chrome with persistent profile (preserves cookies across restarts)
    const launchOptions: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]> = {
      headless: this.options.headless,
      viewport: { width: 1440, height: 900 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--start-maximized"
      ]
    };

    if (this.options.executablePath) {
      launchOptions.executablePath = this.options.executablePath;
    } else {
      launchOptions.channel = "chrome";
    }

    this.context = await chromium.launchPersistentContext(this.options.userDataDir, launchOptions);
    this.page = this.context.pages()[0] ?? (await this.context.newPage());

    // Remove webdriver flag to reduce Cloudflare detection
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    await this.page.goto(this.options.claudeUrl, { waitUntil: "domcontentloaded" });
    await this.waitForClaudeSurface();
    await this.waitUntilLoggedIn();
  }

  async openLoginWindow(): Promise<void> {
    await this.initialize();
    console.log("Chrome window is open. Log in to claude.ai if needed. Keep this process running.");
    await new Promise<void>(() => {});
  }

  async resetConversation(): Promise<void> {
    const page = await this.getPage();
    await page.goto(this.options.claudeUrl, { waitUntil: "domcontentloaded" });
    await this.waitForClaudeSurface();
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

  async close(): Promise<void> {
    await this.page?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.primed = false;
  }

  private async sendPrompt(prompt: string): Promise<string> {
    const page = await this.getPage();
    const composer = await withRetry(
      () => this.resolveComposer(page),
      { retries: limits.maxRetries, initialDelayMs: 500 }
    );

    const previousText = await this.extractLatestAssistantText();

    await composer.click({ timeout: limits.selectorTimeoutMs });

    // Claude.ai uses contenteditable — fill() may not work, use keyboard
    await composer.press("Meta+A").catch(() => undefined);
    await composer.press("Backspace").catch(() => undefined);

    // Type in chunks to avoid detection and handle long prompts
    await page.keyboard.type(prompt, { delay: 5 });

    // Send via button or Enter
    await page.waitForTimeout(300);
    const sendButton = page.locator('button[aria-label*="Send"], button[data-testid="send-button"], button:has(svg[class*="send"])').first();
    if (await sendButton.isVisible().catch(() => false)) {
      await sendButton.click({ timeout: 3000 });
    } else {
      await composer.press("Enter");
    }

    return waitForStableText(() => this.extractLatestAssistantText(), {
      mustDifferFrom: previousText,
      timeoutMs: limits.responseTimeoutMs
    });
  }

  private async extractLatestAssistantText(): Promise<string> {
    const page = await this.getPage();
    const text = (await page.evaluate(() => {
      const clean = (value: string) =>
        value.replace(/\u200b/g, "").replace(/\s+\n/g, "\n").replace(/\s+/g, " ").trim();

      const isVisible = (el: Element) => {
        const node = el as HTMLElement;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      // Claude.ai assistant message selectors
      const selectors = [
        "[data-testid='assistant-message']",
        "[data-is-streaming]",
        ".font-claude-message",
        // Generic fallbacks
        "[class*='assistant-']",
        "[class*='AssistantMessage']"
      ];

      for (const selector of selectors) {
        const elements = Array.from(document.querySelectorAll(selector)).filter(isVisible);
        if (elements.length > 0) {
          const last = elements[elements.length - 1] as HTMLElement;
          return clean(last.innerText || last.textContent || "");
        }
      }

      // Fallback: look for message blocks in conversation area
      const conversationArea =
        document.querySelector("[class*='conversation']") ||
        document.querySelector("[class*='thread']") ||
        document.querySelector("main");
      if (!conversationArea) return "";

      // Find all text blocks that look like messages
      const allBlocks = Array.from(conversationArea.querySelectorAll("div, article, section"))
        .filter(isVisible)
        .filter((el) => {
          const text = (el as HTMLElement).innerText || "";
          // Must have substantial text and not be the whole container
          return text.length > 20 && text.length < 50000 && el.children.length < 50;
        });

      if (allBlocks.length > 0) {
        const last = allBlocks[allBlocks.length - 1] as HTMLElement;
        return clean(last.innerText || "");
      }

      return "";
    })) as string;

    return text.trim();
  }

  private async resolveComposer(page: Page): Promise<Locator> {
    const strategies: (() => Promise<Locator | null>)[] = [
      // ProseMirror contenteditable (primary claude.ai input)
      async () => {
        const loc = page.locator('[contenteditable="true"]:not([aria-hidden="true"])').last();
        return (await isLocatorUsable(loc)) ? loc : null;
      },
      // Role textbox
      async () => {
        const loc = page.getByRole("textbox").last();
        return (await isLocatorUsable(loc)) ? loc : null;
      },
      // Placeholder
      async () => {
        const loc = page.getByPlaceholder(/reply|message|claude|type|ask/i).last();
        return (await isLocatorUsable(loc)) ? loc : null;
      },
      // Textarea
      async () => {
        const loc = page.locator("textarea").last();
        return (await isLocatorUsable(loc)) ? loc : null;
      }
    ];

    for (const strategy of strategies) {
      const locator = await strategy();
      if (locator) return locator;
    }

    throw new Error("Unable to resolve the claude.ai composer. Ensure you are logged in and the page is loaded.");
  }

  private async waitForClaudeSurface(): Promise<void> {
    const page = await this.getPage();
    await page.waitForLoadState("domcontentloaded");
    // Give SPA time to hydrate
    await page.waitForTimeout(3000);
  }

  /**
   * Wait for the user to complete login if needed.
   * Detects Cloudflare challenge and login pages, waits up to 5 minutes.
   */
  private async waitUntilLoggedIn(): Promise<void> {
    const page = await this.getPage();
    const maxWaitMs = 5 * 60 * 1000; // 5 minutes
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const url = page.url();
      const isOnClaude = /claude\.ai/.test(url) && !/login|auth|accounts\.google/.test(url);

      if (isOnClaude) {
        // Check if composer is available (= fully logged in)
        try {
          await this.resolveComposer(page);
          return; // Logged in and ready
        } catch {
          // Composer not found yet — might be Cloudflare or loading
        }
      }

      // Show status to console
      if (/challenges\.cloudflare/.test(url) || (await page.locator("text=Verify you are human").count()) > 0) {
        console.log("Cloudflare challenge detected. Please complete it in the browser window...");
      } else if (/login|auth|accounts\.google/.test(url)) {
        console.log("Login page detected. Please log in to claude.ai in the browser window...");
      }

      await page.waitForTimeout(3000);
    }

    throw new Error("Timed out waiting for claude.ai login. Please log in manually and restart.");
  }

  private async getPage(): Promise<Page> {
    if (!this.page) {
      await this.initialize();
    }
    if (!this.page) {
      throw new Error("Claude.ai page is not initialized.");
    }
    return this.page;
  }
}

async function isLocatorUsable(locator: Locator): Promise<boolean> {
  try {
    const el = locator.first();
    await el.waitFor({ state: "visible", timeout: 1500 });
    return await el.evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (element.getAttribute("aria-disabled") === "true") return false;
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none";
    });
  } catch {
    return false;
  }
}

function resolveChromeExecutable(explicitPath?: string): string | undefined {
  const candidates = [
    explicitPath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
  ].filter((v): v is string => Boolean(v));

  return candidates.find((c) => fsSync.existsSync(c));
}
