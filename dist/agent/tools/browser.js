import { limits } from "../config/limits.js";
import { healSelector } from "../resilience/self-heal.js";
export class BrowserTool {
    contextProvider;
    page = null;
    constructor(contextProvider) {
        this.contextProvider = contextProvider;
    }
    async navigate(url) {
        const page = await this.getPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: limits.toolPageTimeoutMs });
        await page.waitForLoadState("networkidle", { timeout: limits.toolPageTimeoutMs }).catch(() => undefined);
        return {
            url: page.url(),
            title: await page.title()
        };
    }
    async click(selector) {
        const page = await this.getPage();
        const locator = await this.resolveLocator(page, selector);
        await locator.click({ timeout: limits.toolPageTimeoutMs });
        await page.waitForLoadState("networkidle", { timeout: limits.toolPageTimeoutMs }).catch(() => undefined);
        return {
            selector,
            url: page.url(),
            title: await page.title()
        };
    }
    async type(selector, text) {
        const page = await this.getPage();
        const locator = await this.resolveLocator(page, selector);
        await locator.fill(text, { timeout: limits.toolPageTimeoutMs });
        return {
            selector,
            typed: text.length
        };
    }
    async getPage() {
        if (this.page) {
            return this.page;
        }
        const context = await this.contextProvider.getContext();
        this.page = await context.newPage();
        this.page.setDefaultTimeout(limits.toolPageTimeoutMs);
        return this.page;
    }
    async resolveLocator(page, query) {
        const direct = createLocator(page, query);
        if (await isLocatorUsable(direct)) {
            return direct;
        }
        const healed = await healSelector(page, query);
        if (!healed) {
            throw new Error(`Unable to resolve browser selector: ${query}`);
        }
        switch (healed.kind) {
            case "placeholder":
                return page.getByPlaceholder(healed.value);
            case "role":
                return page.getByRole(healed.role, {
                    name: healed.name
                });
            case "text":
                return page.getByText(healed.value, { exact: false });
            default:
                throw new Error(`Unable to self-heal browser selector: ${query}`);
        }
    }
}
function createLocator(page, query) {
    if (query.startsWith("text=")) {
        return page.getByText(query.slice(5), { exact: false });
    }
    if (query.startsWith("placeholder=")) {
        return page.getByPlaceholder(query.slice(12));
    }
    if (query.startsWith("label=")) {
        return page.getByLabel(query.slice(6), { exact: false });
    }
    if (query.startsWith("role=")) {
        const [, descriptor] = query.split("=", 2);
        const [role, name = ""] = descriptor.split(":", 2);
        return name
            ? page.getByRole(role, { name, exact: false })
            : page.getByRole(role);
    }
    if (query.startsWith("css=")) {
        return page.locator(query.slice(4));
    }
    return page.getByText(query, { exact: false });
}
async function isLocatorUsable(locator) {
    try {
        await locator.first().waitFor({ state: "visible", timeout: 1_000 });
        return true;
    }
    catch {
        return false;
    }
}
