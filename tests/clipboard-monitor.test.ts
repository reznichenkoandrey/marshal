import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventType, UiohookKey, type UiohookKeyboardEvent } from "uiohook-napi";

// Mock electron before importing the module under test — ClipboardMonitor
// pulls `clipboard` and `globalShortcut` from it.
const clipboardText = { current: "" };

vi.mock("electron", () => ({
  clipboard: {
    readText: () => clipboardText.current
  },
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn()
  }
}));

// uiohook-napi is a native module — replace with an emitter-like stub so we
// can fire synthetic keydown events.
type Listener = (event: UiohookKeyboardEvent) => void;
const hookListeners: { keydown: Listener[] } = { keydown: [] };

vi.mock("uiohook-napi", async () => {
  const actual = await vi.importActual<typeof import("uiohook-napi")>("uiohook-napi");
  return {
    ...actual,
    uIOhook: {
      on: vi.fn((channel: string, listener: Listener) => {
        if (channel === "keydown") hookListeners.keydown.push(listener);
      }),
      off: vi.fn((channel: string, listener: Listener) => {
        if (channel !== "keydown") return;
        hookListeners.keydown = hookListeners.keydown.filter((l) => l !== listener);
      }),
      start: vi.fn(),
      stop: vi.fn()
    }
  };
});

const { ClipboardMonitor } = await import("../desktop/translator/clipboard-monitor.ts");

function makeKeyEvent(overrides: Partial<UiohookKeyboardEvent>): UiohookKeyboardEvent {
  return {
    type: EventType.EVENT_KEY_PRESSED,
    time: Date.now(),
    keycode: UiohookKey.C,
    altKey: false,
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
    ...overrides
  };
}

function fireKeyDown(event: UiohookKeyboardEvent): void {
  for (const listener of hookListeners.keydown) listener(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  hookListeners.keydown = [];
  clipboardText.current = "";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ClipboardMonitor double-Cmd+C", () => {
  it("emits after two plain Cmd+C within the 600 ms window", async () => {
    const monitor = new ClipboardMonitor();
    const onTranslate = vi.fn();
    monitor.on("translate", onTranslate);
    monitor.start();

    clipboardText.current = "  hello  ";

    fireKeyDown(makeKeyEvent({}));
    vi.advanceTimersByTime(200);
    fireKeyDown(makeKeyEvent({}));

    // Pasteboard read is deferred so Cocoa can commit the copy.
    await vi.advanceTimersByTimeAsync(120);
    expect(onTranslate).toHaveBeenCalledTimes(1);
    expect(onTranslate).toHaveBeenCalledWith("hello");
  });

  it("does not emit on a single Cmd+C", () => {
    const monitor = new ClipboardMonitor();
    const onTranslate = vi.fn();
    monitor.on("translate", onTranslate);
    monitor.start();

    clipboardText.current = "solo";
    fireKeyDown(makeKeyEvent({}));
    vi.advanceTimersByTime(2000);

    expect(onTranslate).not.toHaveBeenCalled();
  });

  it("does not emit when the two presses are further apart than the window", async () => {
    const monitor = new ClipboardMonitor();
    const onTranslate = vi.fn();
    monitor.on("translate", onTranslate);
    monitor.start();

    clipboardText.current = "slow";
    fireKeyDown(makeKeyEvent({}));
    vi.advanceTimersByTime(800);
    fireKeyDown(makeKeyEvent({}));
    await vi.advanceTimersByTimeAsync(120);

    expect(onTranslate).not.toHaveBeenCalled();
  });

  it("ignores Cmd+Shift+C, Cmd+Option+C, Ctrl+C, and the modifier-less C key", async () => {
    const monitor = new ClipboardMonitor();
    const onTranslate = vi.fn();
    monitor.on("translate", onTranslate);
    monitor.start();

    clipboardText.current = "nope";

    fireKeyDown(makeKeyEvent({ shiftKey: true }));
    fireKeyDown(makeKeyEvent({ shiftKey: true }));
    await vi.advanceTimersByTimeAsync(120);
    expect(onTranslate).not.toHaveBeenCalled();

    fireKeyDown(makeKeyEvent({ altKey: true }));
    fireKeyDown(makeKeyEvent({ altKey: true }));
    await vi.advanceTimersByTimeAsync(120);
    expect(onTranslate).not.toHaveBeenCalled();

    fireKeyDown(makeKeyEvent({ metaKey: false, ctrlKey: true }));
    fireKeyDown(makeKeyEvent({ metaKey: false, ctrlKey: true }));
    await vi.advanceTimersByTimeAsync(120);
    expect(onTranslate).not.toHaveBeenCalled();

    fireKeyDown(makeKeyEvent({ metaKey: false }));
    fireKeyDown(makeKeyEvent({ metaKey: false }));
    await vi.advanceTimersByTimeAsync(120);
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it("does not emit when the pasteboard is empty after the second press", async () => {
    const monitor = new ClipboardMonitor();
    const onTranslate = vi.fn();
    monitor.on("translate", onTranslate);
    monitor.start();

    clipboardText.current = "   ";
    fireKeyDown(makeKeyEvent({}));
    vi.advanceTimersByTime(200);
    fireKeyDown(makeKeyEvent({}));
    await vi.advanceTimersByTimeAsync(120);

    expect(onTranslate).not.toHaveBeenCalled();
  });

  it("debounces rapid triple-press so only the first pair emits", async () => {
    const monitor = new ClipboardMonitor();
    const onTranslate = vi.fn();
    monitor.on("translate", onTranslate);
    monitor.start();

    clipboardText.current = "triple";

    fireKeyDown(makeKeyEvent({}));
    vi.advanceTimersByTime(150);
    fireKeyDown(makeKeyEvent({}));
    vi.advanceTimersByTime(150);
    fireKeyDown(makeKeyEvent({}));
    vi.advanceTimersByTime(150);
    fireKeyDown(makeKeyEvent({}));
    await vi.advanceTimersByTimeAsync(120);

    expect(onTranslate).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh double-press after the debounce window passes", async () => {
    const monitor = new ClipboardMonitor();
    const onTranslate = vi.fn();
    monitor.on("translate", onTranslate);
    monitor.start();

    clipboardText.current = "first";
    fireKeyDown(makeKeyEvent({}));
    vi.advanceTimersByTime(200);
    fireKeyDown(makeKeyEvent({}));
    await vi.advanceTimersByTimeAsync(120);
    expect(onTranslate).toHaveBeenCalledTimes(1);

    // Let the 400 ms emit-debounce expire.
    vi.advanceTimersByTime(500);

    clipboardText.current = "second";
    fireKeyDown(makeKeyEvent({}));
    vi.advanceTimersByTime(200);
    fireKeyDown(makeKeyEvent({}));
    await vi.advanceTimersByTimeAsync(120);

    expect(onTranslate).toHaveBeenCalledTimes(2);
    expect(onTranslate).toHaveBeenLastCalledWith("second");
  });
});
