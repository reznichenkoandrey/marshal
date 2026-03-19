import { chromium } from "playwright";
import type { Browser, BrowserContext } from "playwright";

export class PlaywrightBrowserManager {
  browser: Browser | null = null;
  context: BrowserContext | null = null;
  headless: boolean;

  constructor(headless = false) {
    this.headless = headless;
  }

  async getContext(): Promise<BrowserContext> {
    if (this.context) {
      return this.context;
    }

    this.browser = await chromium.launch({ headless: this.headless });
    this.context = await this.browser.newContext();
    return this.context;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
  }
}
