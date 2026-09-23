import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  legacyUserDataPath,
  migrateLegacyUserData,
  MIGRATION_MARKER
} from "../desktop/user-data-migration.ts";

let root = "";
let legacy = "";
let fresh = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-userdata-"));
  legacy = path.join(root, "local-chatgpt-agent");
  fresh = path.join(root, "Marshal");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seedLegacy(): void {
  fs.mkdirSync(path.join(legacy, "captions-context"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "Cache"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "settings.json"), '{"bridgeMode":"claude-cli"}');
  fs.writeFileSync(path.join(legacy, ".env"), "MARSHAL_API_KEY=gsk_x\n");
  fs.writeFileSync(path.join(legacy, "translator-glossary.json"), "[]");
  fs.writeFileSync(path.join(legacy, "captions-context", "cv.md"), "# me");
  fs.writeFileSync(path.join(legacy, "Cache", "junk"), "x".repeat(1000));
}

describe("migrateLegacyUserData (#158)", () => {
  it("copies settings, .env, stores and folders once, skipping Electron caches", () => {
    seedLegacy();
    const result = migrateLegacyUserData(fresh, legacy);
    expect(result.performed).toBe(true);
    expect(result.copied.sort()).toEqual([".env", "captions-context", "settings.json", "translator-glossary.json"]);
    expect(fs.readFileSync(path.join(fresh, ".env"), "utf8")).toContain("gsk_x");
    expect(fs.readFileSync(path.join(fresh, "captions-context", "cv.md"), "utf8")).toBe("# me");
    expect(fs.existsSync(path.join(fresh, "Cache"))).toBe(false);
    expect(fs.existsSync(path.join(fresh, MIGRATION_MARKER))).toBe(true);
    // The legacy directory is left untouched.
    expect(fs.existsSync(path.join(legacy, "settings.json"))).toBe(true);

    const again = migrateLegacyUserData(fresh, legacy);
    expect(again.performed).toBe(false);
    expect(again.reason).toBe("already migrated");
  });

  it("does nothing when there is no legacy directory or the new one is already in use", () => {
    expect(migrateLegacyUserData(fresh, legacy).reason).toBe("no legacy directory");
    seedLegacy();
    fs.mkdirSync(fresh, { recursive: true });
    fs.writeFileSync(path.join(fresh, "settings.json"), '{"bridgeMode":"api"}');
    const result = migrateLegacyUserData(fresh, legacy);
    expect(result.performed).toBe(false);
    expect(fs.readFileSync(path.join(fresh, "settings.json"), "utf8")).toContain("api");
    expect(fs.existsSync(path.join(fresh, ".env"))).toBe(false);
  });

  it("never copies over a file the new app already wrote", () => {
    seedLegacy();
    fs.mkdirSync(fresh, { recursive: true });
    fs.writeFileSync(path.join(fresh, ".env"), "MARSHAL_API_KEY=newer\n");
    migrateLegacyUserData(fresh, legacy);
    expect(fs.readFileSync(path.join(fresh, ".env"), "utf8")).toContain("newer");
  });

  it("derives the legacy path next to the new one", () => {
    expect(legacyUserDataPath("/Users/me/Library/Application Support/Marshal")).toBe(
      "/Users/me/Library/Application Support/local-chatgpt-agent"
    );
    expect(migrateLegacyUserData(legacy, legacy).reason).toBe("same directory");
  });
});
