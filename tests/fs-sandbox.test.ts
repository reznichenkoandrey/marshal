import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSandbox, readWithExtraction } from "../agent/tools/fs.ts";

describe("FileSandbox.readFile / readWithExtraction", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "marshal-fs-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("returns utf-8 content verbatim for plain text files", async () => {
    const target = path.join(workDir, "note.txt");
    await writeFile(target, "привіт, світ\n", "utf8");

    const sandbox = new FileSandbox(workDir, { unrestricted: true });
    const result = await sandbox.readFile(target);

    expect(result.content).toBe("привіт, світ\n");
  });

  it("falls back to raw utf-8 read when extraction is not applicable", async () => {
    // An unknown extension should never touch textutil — tests the happy path
    // for regular code/text reads in the executor loop.
    const target = path.join(workDir, "config.json");
    await writeFile(target, "{\"a\":1}\n", "utf8");

    const content = await readWithExtraction(target);
    expect(content).toBe("{\"a\":1}\n");
  });

  it("falls back to raw read when textutil can't process a file", async () => {
    // Make a file with a .docx extension but bogus content. On macOS textutil
    // will reject it; on other platforms the shell-out never runs. Either
    // way we should get the raw bytes back instead of throwing.
    const fakeDocx = path.join(workDir, "broken.docx");
    await writeFile(fakeDocx, "not a real docx", "utf8");

    const content = await readWithExtraction(fakeDocx);
    expect(content).toBe("not a real docx");
  });
});
