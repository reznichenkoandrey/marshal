import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

// Import the deferred hotkey parser. We avoid importing `PushToTalkHotkey`
// because its constructor touches uiohook-napi's native binary, which isn't
// loadable inside the test host.
import {
  GesturePushToTalkHotkey,
  matchesHotkey,
  parseHotkey,
  type PushToTalkBackend
} from "../desktop/dictation/hotkey-manager.ts";

class FakePttBackend extends EventEmitter implements PushToTalkBackend {
  started = false;
  stopped = false;
  forced = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  forceEnd(): void {
    this.forced = true;
  }

  down(): void {
    this.emit("hold-start");
  }

  up(): void {
    this.emit("hold-end");
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseHotkey", () => {
  it("parses Cmd+Shift+D", () => {
    expect(parseHotkey("Cmd+Shift+D")).toEqual({
      keycode: 32,
      meta: true,
      ctrl: false,
      alt: false,
      shift: true
    });
  });

  it("accepts platform-neutral aliases", () => {
    const a = parseHotkey("Meta+Ctrl+Alt+A");
    expect(a.meta).toBe(true);
    expect(a.ctrl).toBe(true);
    expect(a.alt).toBe(true);
    expect(a.shift).toBe(false);
    expect(a.keycode).toBe(30);
  });

  it("accepts mac-style Option", () => {
    const a = parseHotkey("Option+F");
    expect(a.alt).toBe(true);
    expect(a.meta).toBe(false);
  });

  it("is case-insensitive for modifier names", () => {
    const a = parseHotkey("cmd+shift+d");
    expect(a.meta).toBe(true);
    expect(a.shift).toBe(true);
  });

  it("throws when the target key is missing", () => {
    expect(() => parseHotkey("Cmd+Shift")).toThrow(/missing a target key/iu);
  });

  it("throws when the hotkey has two target keys", () => {
    expect(() => parseHotkey("Cmd+A+B")).toThrow(/more than one target key/iu);
  });

  it("throws on unknown key names", () => {
    expect(() => parseHotkey("Cmd+GlyphThatDoesNotExist")).toThrow(/Unknown key/iu);
  });

  it("parses a pure right-Cmd hotkey", () => {
    // `RightCmd` alone should be a valid push-to-talk trigger: the modifier
    // flag in the resulting spec is false, even though pressing it raises
    // event.metaKey=true at runtime.
    expect(parseHotkey("RightCmd")).toEqual({
      keycode: 3676,
      meta: false,
      ctrl: false,
      alt: false,
      shift: false
    });
  });

  it("accepts RCmd / CmdRight aliases", () => {
    expect(parseHotkey("RCmd").keycode).toBe(3676);
    expect(parseHotkey("CmdRight").keycode).toBe(3676);
    expect(parseHotkey("LeftCmd").keycode).toBe(3675);
  });
});

describe("matchesHotkey", () => {
  const spec = parseHotkey("Cmd+Shift+D");

  it("matches when modifiers and keycode align", () => {
    expect(
      matchesHotkey(
        {
          type: 4,
          time: 0,
          keycode: 32,
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true
        } as never,
        spec
      )
    ).toBe(true);
  });

  it("returns false when a modifier differs", () => {
    expect(
      matchesHotkey(
        {
          type: 4,
          time: 0,
          keycode: 32,
          metaKey: true,
          ctrlKey: true, // extra modifier
          altKey: false,
          shiftKey: true
        } as never,
        spec
      )
    ).toBe(false);
  });

  it("returns false when keycode differs", () => {
    expect(
      matchesHotkey(
        {
          type: 4,
          time: 0,
          keycode: 33,
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true
        } as never,
        spec
      )
    ).toBe(false);
  });

  it("ignores metaKey flag when target key IS the meta modifier", () => {
    // Pressing RightCmd alone: metaKey=true, everything else false.
    // The hotkey spec itself has meta=false — but we should still match,
    // because the meta flag is a side-effect of pressing the target key.
    const rightCmd = parseHotkey("RightCmd");
    expect(
      matchesHotkey(
        {
          type: 4,
          time: 0,
          keycode: 3676,
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false
        } as never,
        rightCmd
      )
    ).toBe(true);
  });

  it("still rejects foreign modifiers when target is a modifier", () => {
    // Holding RightCmd + Shift while releasing should NOT match a pure
    // RightCmd hotkey — shift is extra.
    const rightCmd = parseHotkey("RightCmd");
    expect(
      matchesHotkey(
        {
          type: 4,
          time: 0,
          keycode: 3676,
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true
        } as never,
        rightCmd
      )
    ).toBe(false);
  });
});

describe("GesturePushToTalkHotkey", () => {
  it("suppresses a tap shorter than the hold delay", () => {
    vi.useFakeTimers();
    const inner = new FakePttBackend();
    const hotkey = new GesturePushToTalkHotkey(inner, {
      holdDelayMs: 200,
      toggleTapCount: 0,
      toggleTapThresholdMs: 350
    });
    const events: string[] = [];
    hotkey.on("hold-start", () => events.push("start"));
    hotkey.on("hold-end", () => events.push("end"));

    inner.down();
    vi.advanceTimersByTime(100);
    inner.up();
    vi.advanceTimersByTime(200);

    expect(events).toEqual([]);
  });

  it("starts after the hold delay and ends on release", () => {
    vi.useFakeTimers();
    const inner = new FakePttBackend();
    const hotkey = new GesturePushToTalkHotkey(inner, {
      holdDelayMs: 200,
      toggleTapCount: 0,
      toggleTapThresholdMs: 350
    });
    const events: string[] = [];
    hotkey.on("hold-start", () => events.push("start"));
    hotkey.on("hold-end", () => events.push("end"));

    inner.down();
    vi.advanceTimersByTime(199);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(["start"]);
    inner.up();

    expect(events).toEqual(["start", "end"]);
  });

  it("toggles hands-free recording with repeated taps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const inner = new FakePttBackend();
    const hotkey = new GesturePushToTalkHotkey(inner, {
      holdDelayMs: 200,
      toggleTapCount: 2,
      toggleTapThresholdMs: 350
    });
    const events: string[] = [];
    hotkey.on("hold-start", () => events.push("start"));
    hotkey.on("hold-end", () => events.push("end"));

    inner.down();
    inner.up();
    vi.setSystemTime(1_200);
    inner.down();
    inner.up();
    expect(events).toEqual(["start"]);

    vi.setSystemTime(1_400);
    inner.down();
    inner.up();
    vi.setSystemTime(1_550);
    inner.down();
    inner.up();
    expect(events).toEqual(["start", "end"]);
  });

  it("forceEnd clears pending and active gesture state", () => {
    vi.useFakeTimers();
    const inner = new FakePttBackend();
    const hotkey = new GesturePushToTalkHotkey(inner, {
      holdDelayMs: 200,
      toggleTapCount: 0,
      toggleTapThresholdMs: 350
    });
    const events: string[] = [];
    hotkey.on("hold-start", () => events.push("start"));
    hotkey.on("hold-end", () => events.push("end"));

    inner.down();
    vi.advanceTimersByTime(200);
    hotkey.forceEnd();

    expect(inner.forced).toBe(true);
    expect(events).toEqual(["start", "end"]);
  });
});
