import { chromium } from "playwright";
export class PlaywrightBrowserManager {
    browser = null;
    context = null;
    headless;
    constructor(headless = false) {
        this.headless = headless;
    }
    async getContext() {
        if (this.context) {
            return this.context;
        }
        this.browser = await chromium.launch({ headless: this.headless });
        this.context = await this.browser.newContext();
        return this.context;
    }
    async close() {
        await this.context?.close().catch(() => undefined);
        await this.browser?.close().catch(() => undefined);
        this.context = null;
        this.browser = null;
    }
}
