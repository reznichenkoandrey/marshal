import { limits } from "../config/limits.js";
import { healSelector } from "../resilience/self-heal.js";
export function createSelectorCache() {
    return new Map();
}
async function isUsable(locator) {
    try {
        const candidate = locator.first();
        await candidate.waitFor({ state: "visible", timeout: 1_000 });
        return await candidate.evaluate((element) => {
            if (!(element instanceof HTMLElement)) {
                return false;
            }
            if (element.getAttribute("aria-disabled") === "true") {
                return false;
            }
            if ("disabled" in element && typeof element.disabled === "boolean" && element.disabled) {
                return false;
            }
            const style = window.getComputedStyle(element);
            return style.visibility !== "hidden" && style.display !== "none";
        });
    }
    catch {
        return false;
    }
}
async function pickFirstUsable(locators) {
    for (const locator of locators) {
        if (await isUsable(locator)) {
            return locator;
        }
    }
    return null;
}
export async function resolveComposer(page, cache) {
    const preferred = cache.get("composer");
    const candidates = buildComposerStrategies(page);
    if (preferred) {
        const locator = await candidates[preferred]?.();
        if (locator && (await isUsable(locator))) {
            return locator;
        }
    }
    for (const [strategy, createLocator] of Object.entries(candidates)) {
        const locator = await createLocator();
        if (locator && (await isUsable(locator))) {
            cache.set("composer", strategy);
            return locator;
        }
    }
    throw new Error("Unable to resolve the ChatGPT composer textbox.");
}
export async function clickNewChatIfAvailable(page, cache) {
    const strategy = cache.get("new-chat");
    const roleLink = page.getByRole("link", { name: /new chat|new conversation/i }).first();
    const roleButton = page.getByRole("button", { name: /new chat|new conversation/i }).first();
    const locators = strategy === "role-textbox"
        ? [roleLink, roleButton]
        : [roleButton, roleLink];
    const usable = await pickFirstUsable(locators);
    if (!usable) {
        return;
    }
    cache.set("new-chat", usable === roleButton ? "placeholder-message" : "role-textbox");
    await usable.click({ timeout: limits.selectorTimeoutMs });
}
function buildComposerStrategies(page) {
    return {
        "role-textbox": async () => pickFirstUsable([
            page.getByRole("textbox", { name: /message|ask|chat|anything/i }).last(),
            page.getByRole("textbox").last()
        ]),
        "placeholder-message": async () => pickFirstUsable([
            page.getByPlaceholder(/message|anything/i).last(),
            page.getByPlaceholder(/send a message|ask anything/i).last()
        ]),
        "contenteditable-role": async () => pickFirstUsable([page.locator('[role="textbox"][contenteditable="true"]').last()]),
        contenteditable: async () => pickFirstUsable([page.locator('[contenteditable="true"]').last()]),
        textarea: async () => pickFirstUsable([page.locator("textarea").last()]),
        heal: async () => {
            const healed = await healSelector(page, "message chat input");
            if (!healed) {
                return null;
            }
            switch (healed.kind) {
                case "placeholder":
                    return page.getByPlaceholder(healed.value).last();
                case "role":
                    return page.getByRole(healed.role, {
                        name: healed.name
                    }).first();
                case "text":
                    return page.getByText(healed.value).last();
                default:
                    return null;
            }
        }
    };
}
