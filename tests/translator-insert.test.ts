import { beforeEach, describe, expect, it, vi } from "vitest";

// Electron's clipboard needs a running app; back it with a plain string so we
// can assert the snapshot/restore contract.
let clipboardText = "";
const clipboardMock = {
  readText: () => clipboardText,
  writeText: (value: string) => {
    clipboardText = value;
  }
};

vi.mock("electron", () => ({ clipboard: clipboardMock }));

// Import AFTER vi.mock so the mocked electron module is used.
const { insertTranslation } = await import("../desktop/translator/insert-service.ts");

const noSleep = async () => {};

beforeEach(() => {
  clipboardText = "";
});

describe("insertTranslation", () => {
  it("hides the window before pasting so focus is back in the other app", async () => {
    const order: string[] = [];
    const outcome = await insertTranslation("Привіт", {
      hideWindow: () => order.push("hide"),
      paste: async () => {
        order.push("paste");
      },
      sleep: noSleep
    });

    expect(outcome).toEqual({ ok: true });
    expect(order).toEqual(["hide", "paste"]);
  });

  it("puts the translation on the clipboard, then restores what was there", async () => {
    clipboardText = "user's own content";
    let seenDuringPaste = "";

    await insertTranslation("Привіт", {
      hideWindow: () => {},
      paste: async () => {
        seenDuringPaste = clipboardMock.readText();
      },
      sleep: noSleep
    });

    expect(seenDuringPaste).toBe("Привіт");
    expect(clipboardText).toBe("user's own content");
  });

  it("trims the payload", async () => {
    let pasted = "";
    await insertTranslation("  Привіт  ", {
      hideWindow: () => {},
      paste: async () => {
        pasted = clipboardMock.readText();
      },
      sleep: noSleep
    });
    expect(pasted).toBe("Привіт");
  });

  it("refuses empty text without touching the clipboard", async () => {
    clipboardText = "keep me";
    const paste = vi.fn();
    const outcome = await insertTranslation("   ", {
      hideWindow: () => {},
      paste: async () => paste(),
      sleep: noSleep
    });

    expect(outcome).toEqual({ ok: false, reason: "empty" });
    expect(paste).not.toHaveBeenCalled();
    expect(clipboardText).toBe("keep me");
  });

  it("leaves the translation on the clipboard when the keystroke fails", async () => {
    clipboardText = "user's own content";
    const outcome = await insertTranslation("Привіт", {
      hideWindow: () => {},
      paste: async () => {
        throw new Error("send-keystroke exited 1");
      },
      sleep: noSleep
    });

    expect(outcome).toMatchObject({ ok: false, reason: "paste-failed" });
    expect(clipboardText).toBe("Привіт");
  });
});
