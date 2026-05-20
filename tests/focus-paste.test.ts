// tests/focus-paste.test.ts
// Unit tests for the pure helpers in focus-paste.ts. The spawn-based bridges
// to Swift binaries are exercised through the optional `binPath` override so
// no real macOS AX traffic happens here.

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";

import {
  parseFocusProbe,
  probeFocusedElement,
  sendPasteKeystroke
} from "../desktop/dictation/focus-paste.ts";

void spawn;

const __filename = fileURLToPath(import.meta.url);
const tmpRoot = path.join(os.tmpdir(), "marshal-focus-paste-tests");

async function writeStubBin(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(`${tmpRoot}-`);
  const target = path.join(dir, name);
  await writeFile(target, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(target, 0o755);
  return target;
}

void __filename;

describe("parseFocusProbe", () => {
  it("parses a well-formed JSON response", () => {
    const result = parseFocusProbe('{"isTextInput":true,"role":"AXTextField","subrole":""}');
    expect(result).toEqual({ isTextInput: true, role: "AXTextField", subrole: "" });
  });

  it("trims surrounding whitespace and newlines", () => {
    const result = parseFocusProbe('   {"isTextInput":false,"role":"AXButton","subrole":""}\n');
    expect(result.isTextInput).toBe(false);
    expect(result.role).toBe("AXButton");
  });

  it("falls back to safe defaults on empty input", () => {
    expect(parseFocusProbe("")).toEqual({ isTextInput: false, role: "", subrole: "" });
    expect(parseFocusProbe("   ")).toEqual({ isTextInput: false, role: "", subrole: "" });
  });

  it("falls back when JSON is malformed", () => {
    expect(parseFocusProbe("not json at all")).toEqual({
      isTextInput: false,
      role: "",
      subrole: ""
    });
    expect(parseFocusProbe('{"isTextInput":true')).toEqual({
      isTextInput: false,
      role: "",
      subrole: ""
    });
  });

  it("treats non-boolean isTextInput as false (strict equality)", () => {
    expect(parseFocusProbe('{"isTextInput":"true","role":"X"}').isTextInput).toBe(false);
    expect(parseFocusProbe('{"isTextInput":1,"role":"X"}').isTextInput).toBe(false);
  });

  it("coerces missing string fields to empty strings", () => {
    const result = parseFocusProbe('{"isTextInput":true}');
    expect(result).toEqual({ isTextInput: true, role: "", subrole: "" });
  });

  it("rejects non-object top-level values", () => {
    expect(parseFocusProbe("null")).toEqual({ isTextInput: false, role: "", subrole: "" });
    expect(parseFocusProbe('"AXTextField"')).toEqual({
      isTextInput: false,
      role: "",
      subrole: ""
    });
    expect(parseFocusProbe("[true, true]")).toEqual({
      isTextInput: false,
      role: "",
      subrole: ""
    });
  });
});

describe("probeFocusedElement", () => {
  it("returns parsed JSON when the helper exits cleanly", async () => {
    const bin = await writeStubBin(
      "focus-probe-success",
      'echo \'{"isTextInput":true,"role":"AXTextField","subrole":""}\''
    );
    try {
      const result = await probeFocusedElement({ binPath: bin });
      expect(result).toEqual({ isTextInput: true, role: "AXTextField", subrole: "" });
    } finally {
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  it("resolves to clipboard-only fallback if the binary is missing", async () => {
    const result = await probeFocusedElement({
      binPath: "/nonexistent/path/focus-probe-does-not-exist"
    });
    expect(result).toEqual({ isTextInput: false, role: "", subrole: "" });
  });

  it("times out gracefully when the helper hangs", async () => {
    const bin = await writeStubBin("focus-probe-hang", "sleep 5");
    try {
      const start = Date.now();
      const result = await probeFocusedElement({ binPath: bin, timeoutMs: 100 });
      const elapsed = Date.now() - start;
      expect(result.isTextInput).toBe(false);
      // Generous upper bound — the timer fires at ~100 ms; SIGKILL + close
      // event have some slack on slow CI but should be well under 2 s.
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  it("falls back on malformed helper output", async () => {
    const bin = await writeStubBin("focus-probe-garbage", 'echo "not a json"');
    try {
      const result = await probeFocusedElement({ binPath: bin });
      expect(result).toEqual({ isTextInput: false, role: "", subrole: "" });
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
