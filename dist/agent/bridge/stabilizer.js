import { limits } from "../config/limits.js";
import { sleep } from "../resilience/retry.js";
export async function waitForStableText(readText, options = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? limits.responsePollIntervalMs;
    const requiredStableReads = options.requiredStableReads ?? limits.responseStableReads;
    const timeoutMs = options.timeoutMs ?? limits.responseTimeoutMs;
    const mustDifferFrom = options.mustDifferFrom ?? null;
    const startedAt = Date.now();
    let stableReads = 0;
    let lastValue = "";
    while (Date.now() - startedAt < timeoutMs) {
        const value = (await readText()).trim();
        const changedFromBaseline = mustDifferFrom === null || value !== mustDifferFrom;
        if (value && changedFromBaseline && value === lastValue) {
            stableReads += 1;
            if (stableReads >= requiredStableReads) {
                return value;
            }
        }
        else {
            stableReads = 1;
            lastValue = value;
        }
        await sleep(pollIntervalMs);
    }
    if (lastValue.trim().length > 0) {
        return lastValue.trim();
    }
    throw new Error("Timed out while waiting for a stable assistant response.");
}
