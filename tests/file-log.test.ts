import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFileLog, logFileName, logStamp } from "../desktop/file-log.ts";

const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };

afterEach(() => Object.assign(console, saved));

describe("file log (#554)", () => {
  it("stamps local time and names the file by local day", () => {
    const date = new Date(2026, 10, 27, 9, 5, 3, 7);
    expect(logStamp(date)).toBe("2026-11-27 09:05:03.007");
    expect(logFileName(date)).toBe("marshal-2026-11-27.log");
  });

  it("mirrors console lines into a 0600 file per day", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-log-")), "logs");
    let now = new Date(2026, 10, 27, 23, 59, 59, 0);
    Object.assign(console, { log: () => {}, info: () => {}, warn: () => {}, error: () => {} });
    installFileLog(dir, () => now);
    console.log("[voice] ask %s", "Дозволити?");
    console.warn("[wake] answer window closed", { ms: 6000 });
    now = new Date(2026, 10, 28, 0, 0, 1, 0);
    console.error("next day");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const first = fs.readFileSync(path.join(dir, "marshal-2026-11-27.log"), "utf8");
    expect(first).toBe("2026-11-27 23:59:59.000 log [voice] ask Дозволити?\n2026-11-27 23:59:59.000 warn [wake] answer window closed { ms: 6000 }\n");
    expect(fs.readFileSync(path.join(dir, "marshal-2026-11-28.log"), "utf8")).toBe("2026-11-28 00:00:01.000 error next day\n");
    expect(fs.statSync(path.join(dir, "marshal-2026-11-27.log")).mode & 0o777).toBe(0o600);
  });
});
