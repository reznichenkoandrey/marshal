import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OperatorSessionStore } from "../operator/session-store.ts";

describe("OperatorSessionStore data dir (#206)", () => {
  const saved = process.env.MARSHAL_OPERATOR_DATA_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.MARSHAL_OPERATOR_DATA_DIR;
    else process.env.MARSHAL_OPERATOR_DATA_DIR = saved;
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
    expect(new OperatorSessionStore().rootDir).toBe(path.resolve(process.cwd(), "operator-data"));
  });
});
