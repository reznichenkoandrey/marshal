import { describe, expect, it } from "vitest";

// Import the deferred hotkey parser. We avoid importing `PushToTalkHotkey`
// because its constructor touches uiohook-napi's native binary, which isn't
// loadable inside the test host.
import { parseHotkey, matchesHotkey } from "../desktop/dictation/hotkey-manager.ts";

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
});
