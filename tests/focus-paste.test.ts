// tests/focus-paste.test.ts
// Unit tests for the pure helpers in focus-paste.ts. The spawn-based bridges
// to Swift binaries are exercised through the optional `binPath` override so
// no real macOS AX traffic happens here.

import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";

import {
  decideAutoPaste,
  isAxBlind,
  parseFocusProbe,
  probeFocusedElement,
  sendPasteKeystroke,
  type FocusProbeResult
} from "../desktop/dictation/focus-paste.ts";

const tmpRoot = path.join(os.tmpdir(), "marshal-focus-paste-tests");

async function writeStubBin(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(`${tmpRoot}-`);
  const target = path.join(dir, name);
  await writeFile(target, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(target, 0o755);
  return target;
}

const EMPTY: FocusProbeResult = {
  isTextInput: false,
  role: "",
  subrole: "",
  axError: -1,
  axTrusted: false,
  frontmostApp: ""
};

describe("parseFocusProbe", () => {
  it("parses a well-formed JSON response with diagnostics", () => {
    const result = parseFocusProbe(
      '{"isTextInput":true,"role":"AXTextField","subrole":"","axError":0,"axTrusted":true,"frontmostApp":"Notes"}'
    );
    expect(result).toEqual({
      isTextInput: true,
      role: "AXTextField",
      subrole: "",
      axError: 0,
      axTrusted: true,
      frontmostApp: "Notes"
    });
  });

  it("trims surrounding whitespace and newlines", () => {
    const result = parseFocusProbe(
      '   {"isTextInput":false,"role":"AXButton","subrole":"","axError":0,"axTrusted":true,"frontmostApp":"X"}\n'
    );
    expect(result.isTextInput).toBe(false);
    expect(result.role).toBe("AXButton");
    expect(result.frontmostApp).toBe("X");
  });

  it("falls back to safe defaults on empty input", () => {
    expect(parseFocusProbe("")).toEqual(EMPTY);
    expect(parseFocusProbe("   ")).toEqual(EMPTY);
  });

  it("falls back when JSON is malformed", () => {
    expect(parseFocusProbe("not json at all")).toEqual(EMPTY);
    expect(parseFocusProbe('{"isTextInput":true')).toEqual(EMPTY);
  });

  it("treats non-boolean isTextInput as false (strict equality)", () => {
    expect(parseFocusProbe('{"isTextInput":"true","role":"X"}').isTextInput).toBe(false);
    expect(parseFocusProbe('{"isTextInput":1,"role":"X"}').isTextInput).toBe(false);
  });

  it("coerces missing fields to safe defaults", () => {
    const result = parseFocusProbe('{"isTextInput":true}');
    expect(result).toEqual({
      isTextInput: true,
      role: "",
      subrole: "",
      axError: -1,
      axTrusted: false,
      frontmostApp: ""
    });
  });

  it("preserves negative axError codes (real AX failure)", () => {
    const result = parseFocusProbe(
      '{"isTextInput":false,"role":"","subrole":"","axError":-25204,"axTrusted":true,"frontmostApp":"Claude"}'
    );
    expect(result.axError).toBe(-25204);
    expect(result.axTrusted).toBe(true);
    expect(result.frontmostApp).toBe("Claude");
  });

  it("rejects non-object top-level values", () => {
    expect(parseFocusProbe("null")).toEqual(EMPTY);
    expect(parseFocusProbe('"AXTextField"')).toEqual(EMPTY);
    expect(parseFocusProbe("[true, true]")).toEqual(EMPTY);
  });
});

describe("decideAutoPaste", () => {
  function make(overrides: Partial<FocusProbeResult>): FocusProbeResult {
    return {
      isTextInput: false,
      role: "",
      subrole: "",
      axError: 0,
      axTrusted: true,
      frontmostApp: "",
      ...overrides
    };
  }

  it("pastes when AX confirms a text input", () => {
    expect(decideAutoPaste(make({ isTextInput: true, role: "AXTextField" }))).toBe(true);
  });

  it("does not paste when AX returns a clean non-text role", () => {
    expect(decideAutoPaste(make({ role: "AXButton", axError: 0 }))).toBe(false);
    expect(decideAutoPaste(make({ role: "AXRow", axError: 0 }))).toBe(false);
  });

  it("fails open and pastes when AX cannot read the target (e.g. Tauri Claude)", () => {
    // Real-world payload: Claude desktop app under macOS shows axError=-25204
    // and an empty role. We want paste to still happen since the user almost
    // certainly meant to dictate into Claude's prompt.
    const focus = make({
      isTextInput: false,
      role: "",
      axError: -25204,
      frontmostApp: "Claude"
    });
    expect(decideAutoPaste(focus)).toBe(true);
  });

  it("skips paste when AX is blind AND frontmost app is on the no-text blacklist", () => {
    for (const app of [
      "Finder",
      "Mission Control",
      "Notification Center",
      "Notification Centre",
      "Dock",
      "loginwindow"
    ]) {
      const focus = make({ axError: -25204, frontmostApp: app });
      expect(decideAutoPaste(focus), `expected no-paste for ${app}`).toBe(false);
    }
  });

  it("treats empty role as AX-blind even when error is reported as 0", () => {
    // Defensive: if probe somehow reports success but role is empty, we still
    // want the fail-open path so we never silently swallow paste.
    const focus = make({ isTextInput: false, role: "", axError: 0, frontmostApp: "Anything" });
    expect(decideAutoPaste(focus)).toBe(true);
  });
});

describe("isAxBlind", () => {
  function make(overrides: Partial<FocusProbeResult>): FocusProbeResult {
    return {
      isTextInput: false,
      role: "",
      subrole: "",
      axError: 0,
      axTrusted: true,
      frontmostApp: "",
      ...overrides
    };
  }

  it("returns true when axError is non-zero", () => {
    expect(isAxBlind(make({ axError: -25204 }))).toBe(true);
  });

  it("returns true when role is empty even on success", () => {
    expect(isAxBlind(make({ axError: 0, role: "" }))).toBe(true);
  });

  it("returns false when AX gave a clean answer with a populated role", () => {
    expect(isAxBlind(make({ axError: 0, role: "AXTextField" }))).toBe(false);
    expect(isAxBlind(make({ axError: 0, role: "AXButton" }))).toBe(false);
  });
});

describe("probeFocusedElement", () => {
  it("returns parsed JSON when the helper exits cleanly", async () => {
    const bin = await writeStubBin(
      "focus-probe-success",
      'echo \'{"isTextInput":true,"role":"AXTextField","subrole":"","axError":0,"axTrusted":true,"frontmostApp":"Notes"}\''
    );
    try {
      const result = await probeFocusedElement({ binPath: bin });
      expect(result.isTextInput).toBe(true);
      expect(result.role).toBe("AXTextField");
      expect(result.frontmostApp).toBe("Notes");
    } finally {
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  it("resolves to fallback if the binary is missing", async () => {
    const result = await probeFocusedElement({
      binPath: "/nonexistent/path/focus-probe-does-not-exist"
    });
    expect(result).toEqual(EMPTY);
  });

  it("times out gracefully when the helper hangs", async () => {
    const bin = await writeStubBin("focus-probe-hang", "sleep 5");
    try {
      const start = Date.now();
      const result = await probeFocusedElement({ binPath: bin, timeoutMs: 100 });
      const elapsed = Date.now() - start;
      expect(result).toEqual(EMPTY);
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  it("falls back on malformed helper output", async () => {
    const bin = await writeStubBin("focus-probe-garbage", 'echo "not a json"');
    try {
      const result = await probeFocusedElement({ binPath: bin });
      expect(result).toEqual(EMPTY);
    } finally {
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });
});

describe("sendPasteKeystroke", () => {
  it("resolves on exit 0", async () => {
    const bin = await writeStubBin("send-keystroke-ok", "exit 0");
    try {
      await expect(sendPasteKeystroke({ binPath: bin })).resolves.toBeUndefined();
    } finally {
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  it("rejects with stderr in the message on non-zero exit", async () => {
    const bin = await writeStubBin(
      "send-keystroke-fail",
      'echo "no accessibility" >&2; exit 7'
    );
    try {
      await expect(sendPasteKeystroke({ binPath: bin })).rejects.toThrow(/exited 7/);
      await expect(sendPasteKeystroke({ binPath: bin })).rejects.toThrow(/no accessibility/);
    } finally {
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  it("rejects if the binary is missing", async () => {
    await expect(
      sendPasteKeystroke({ binPath: "/nonexistent/send-keystroke" })
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects via timeout when the helper hangs", async () => {
    const bin = await writeStubBin("send-keystroke-hang", "sleep 5");
    try {
      await expect(
        sendPasteKeystroke({ binPath: bin, timeoutMs: 80 })
      ).rejects.toThrow(/timed out/);
    } finally {
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });
});
