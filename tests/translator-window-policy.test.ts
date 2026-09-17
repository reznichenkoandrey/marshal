import { describe, expect, it } from "vitest";

import {
  decideHotkeyAction,
  shouldHideOnBlur
} from "../desktop/translator/window-policy.ts";

describe("shouldHideOnBlur", () => {
  it("hides an empty window — that is the glance-tool behaviour", () => {
    expect(shouldHideOnBlur({ pinned: false, hasContent: false })).toBe(true);
  });

  it("keeps a window that holds a translation in progress", () => {
    // The whole bug: a notification or an app launching steals focus, and the
    // half-typed sentence went with it (#166).
    expect(shouldHideOnBlur({ pinned: false, hasContent: true })).toBe(false);
  });

  it("never hides a pinned window, with or without text", () => {
    expect(shouldHideOnBlur({ pinned: true, hasContent: false })).toBe(false);
    expect(shouldHideOnBlur({ pinned: true, hasContent: true })).toBe(false);
  });
});

describe("decideHotkeyAction", () => {
  const base = { visible: false, focused: false, hasContent: false, clipboardText: "" };

  it("hides a window that is already in front", () => {
    expect(decideHotkeyAction({ ...base, visible: true, focused: true })).toBe("hide");
  });

  it("raises a window that is open but behind something", () => {
    expect(decideHotkeyAction({ ...base, visible: true, focused: false })).toBe("show");
  });

  it("brings back waiting text instead of overwriting it with the clipboard", () => {
    expect(
      decideHotkeyAction({ ...base, hasContent: true, clipboardText: "something copied" })
    ).toBe("show");
  });

  it("translates the clipboard when the window is hidden and empty", () => {
    expect(decideHotkeyAction({ ...base, clipboardText: "hello" })).toBe("translate-clipboard");
  });

  it("still shows the window when there is nothing to translate", () => {
    // A global hotkey that silently does nothing reads as a broken one — this
    // was the reported "I have to open Marshal and click Translator".
    expect(decideHotkeyAction(base)).toBe("show");
    expect(decideHotkeyAction({ ...base, clipboardText: "   \n  " })).toBe("show");
  });

  it("treats whitespace-only clipboard as empty", () => {
    expect(decideHotkeyAction({ ...base, clipboardText: "\t \n" })).toBe("show");
  });
});
