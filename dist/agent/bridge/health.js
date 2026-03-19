import { getSharedLocalBridgeServer } from "./local-bridge-server.js";
export async function initializeBridgeHealthSurface() {
    const mode = getBridgeMode();
    if (mode === "extension") {
        await getSharedLocalBridgeServer().start();
    }
}
export async function getBridgeHealth() {
    const mode = getBridgeMode();
    if (mode === "playwright") {
        return getPlaywrightBridgeHealth();
    }
    const server = getSharedLocalBridgeServer();
    await server.start();
    const health = server.getHealth();
    const clientState = health.client?.state ?? null;
    const status = clientState === "ready" ? "ready" : health.client ? "connected" : "waiting";
    return {
        mode: "extension",
        status,
        port: health.port,
        clientCount: health.clientCount,
        queueSize: health.queueSize,
        client: health.client
            ? {
                url: health.client.url,
                title: health.client.title,
                state: health.client.state,
                updatedAt: health.client.updatedAt
            }
            : null
    };
}
async function getPlaywrightBridgeHealth() {
    const cdpUrl = process.env.CHATGPT_CDP_URL ?? null;
    if (!cdpUrl) {
        return {
            mode: "playwright",
            status: "waiting",
            cdpUrl: null,
            details: "CHATGPT_CDP_URL is not configured."
        };
    }
    try {
        const versionUrl = new URL("/json/version", cdpUrl).toString();
        const response = await fetch(versionUrl);
        if (!response.ok) {
            throw new Error(`CDP probe returned ${response.status}.`);
        }
        return {
            mode: "playwright",
            status: "connected",
            cdpUrl,
            details: "Connected to a running Chrome debugging endpoint."
        };
    }
    catch (error) {
        return {
            mode: "playwright",
            status: "configured",
            cdpUrl,
            details: error instanceof Error ? error.message : "Unable to reach the configured CDP endpoint."
        };
    }
}
function getBridgeMode() {
    return (process.env.CHATGPT_BRIDGE_MODE ?? "extension").toLowerCase() === "playwright"
        ? "playwright"
        : "extension";
}
