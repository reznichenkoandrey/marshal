import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveDataPath } from "../agent/config/data-path.ts";
import { OperatorSessionStore } from "../operator/session-store.ts";

describe("agent data root (#206, #233)", () => {
  const saved = { operator: process.env.MARSHAL_OPERATOR_DATA_DIR, data: process.env.MARSHAL_DATA_DIR };
  afterEach(() => {
    for (const [key, value] of [["MARSHAL_OPERATOR_DATA_DIR", saved.operator], ["MARSHAL_DATA_DIR", saved.data]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("uses MARSHAL_OPERATOR_DATA_DIR instead of the cwd, which is / for a packaged app", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marshal-operator-"));
    process.env.MARSHAL_OPERATOR_DATA_DIR = dir;

    const store = new OperatorSessionStore();
    await store.initialize();

    expect(store.rootDir).toBe(dir);
    await expect(fs.stat(path.join(dir, "projects"))).resolves.toBeTruthy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("falls back to <cwd>/operator-data in dev", () => {
    delete process.env.MARSHAL_OPERATOR_DATA_DIR;
    delete process.env.MARSHAL_DATA_DIR;
    expect(new OperatorSessionStore().rootDir).toBe(path.resolve(process.cwd(), "operator-data"));
  });

  it("puts operator data and browser profiles under MARSHAL_DATA_DIR in a packaged build", () => {
    delete process.env.MARSHAL_OPERATOR_DATA_DIR;
    process.env.MARSHAL_DATA_DIR = "/Users/me/Library/Application Support/Marshal";
    expect(new OperatorSessionStore().rootDir).toBe("/Users/me/Library/Application Support/Marshal/operator-data");
    // Relative paths from .env.example land in the same root; absolute ones are kept.
    expect(resolveDataPath("./agent/.chrome-profile")).toBe("/Users/me/Library/Application Support/Marshal/agent/.chrome-profile");
    expect(resolveDataPath("/tmp/profile")).toBe("/tmp/profile");
  });
});
