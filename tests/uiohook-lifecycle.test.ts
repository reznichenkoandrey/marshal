import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const start = vi.fn();
const stop = vi.fn();

vi.mock("uiohook-napi", () => ({
  uIOhook: { start, stop }
}));

// Re-import per test so the module-level counters reset between cases.
async function load() {
  vi.resetModules();
  start.mockClear();
  stop.mockClear();
  return await import("../desktop/uiohook-lifecycle.ts");
}

describe("uiohook-lifecycle", () => {
  beforeEach(() => {
    start.mockClear();
    stop.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts the hook on first acquire and stops after the last release", async () => {
    const { acquireUiohook } = await load();
    const releaseA = acquireUiohook();
    const releaseB = acquireUiohook();

    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    releaseA();
    expect(stop).not.toHaveBeenCalled();

    releaseB();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated release() calls from the same acquire", async () => {
    const { acquireUiohook } = await load();
    const release = acquireUiohook();
    release();
    release();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("restarts the hook after a full release/re-acquire cycle", async () => {
    const { acquireUiohook } = await load();
    acquireUiohook()();
    acquireUiohook();

    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("shutdownUiohookForQuit force-stops regardless of refcount and blocks further acquires", async () => {
    const { acquireUiohook, shutdownUiohookForQuit } = await load();
    acquireUiohook();
    acquireUiohook();
    expect(start).toHaveBeenCalledTimes(1);

    shutdownUiohookForQuit();
    expect(stop).toHaveBeenCalledTimes(1);

    const releaseAfterQuit = acquireUiohook();
    releaseAfterQuit();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("shutdownUiohookForQuit is idempotent when the hook was never started", async () => {
    const { shutdownUiohookForQuit } = await load();
    shutdownUiohookForQuit();
    shutdownUiohookForQuit();
    expect(stop).not.toHaveBeenCalled();
  });
});
