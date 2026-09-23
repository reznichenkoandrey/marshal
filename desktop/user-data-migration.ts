// desktop/user-data-migration.ts
//
// Electron names `app.getPath("userData")` after package.json's productName
// (or `name` when absent). Until 0.3.x there was no top-level productName,
// so an app called Marshal kept its settings, .env, glossary and captures
// under "~/Library/Application Support/local-chatgpt-agent/" (#158). Adding
// productName moves the directory to ".../Marshal/", which would orphan
// everything the user has configured — so the first launch of the renamed
// app copies the old directory over, once.
//
// Pure file logic, given both paths, so it is testable with temp dirs.

import fs from "node:fs";
import path from "node:path";

export const LEGACY_USER_DATA_NAME = "local-chatgpt-agent";
export const MIGRATION_MARKER = ".migrated-from-local-chatgpt-agent";

/** Electron's own caches: large, regenerated on demand, not worth copying. */
const SKIPPED_ENTRIES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "blob_storage",
  "Session Storage",
  "Service Worker",
  "Crashpad",
  "logs",
  "DIPS",
  "DIPS-wal",
  "DIPS-journal",
  "DevToolsActivePort",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket"
]);

export interface UserDataMigrationResult {
  performed: boolean;
  from: string;
  to: string;
  copied: string[];
  reason: string;
}

/**
 * Copies the legacy directory's user files into the new one when the new
 * one has not been used yet. Never deletes the old directory and never
 * overwrites: a file the new app already wrote wins.
 */
export function migrateLegacyUserData(newUserData: string, legacyUserData: string): UserDataMigrationResult {
  const result: UserDataMigrationResult = { performed: false, from: legacyUserData, to: newUserData, copied: [], reason: "" };
  if (path.resolve(newUserData) === path.resolve(legacyUserData)) {
    result.reason = "same directory";
    return result;
  }
  if (!fs.existsSync(legacyUserData)) {
    result.reason = "no legacy directory";
    return result;
  }
  if (fs.existsSync(path.join(newUserData, MIGRATION_MARKER))) {
    result.reason = "already migrated";
    return result;
  }
  if (fs.existsSync(path.join(newUserData, "settings.json"))) {
    // The renamed app has been configured on its own; do not mix histories.
    result.reason = "new directory already in use";
    return result;
  }

  fs.mkdirSync(newUserData, { recursive: true });
  for (const entry of fs.readdirSync(legacyUserData)) {
    if (SKIPPED_ENTRIES.has(entry)) continue;
    const from = path.join(legacyUserData, entry);
    const to = path.join(newUserData, entry);
    if (fs.existsSync(to)) continue;
    try {
      fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: false });
      result.copied.push(entry);
    } catch (err) {
      // One unreadable file must not abort the rest of the settings.
      console.warn(`[marshal] userData migration: could not copy ${entry}:`, err instanceof Error ? err.message : err);
    }
  }
  fs.writeFileSync(
    path.join(newUserData, MIGRATION_MARKER),
    `Copied from ${legacyUserData} on ${new Date().toISOString()}\n${result.copied.join("\n")}\n`,
    "utf8"
  );
  result.performed = true;
  result.reason = `copied ${result.copied.length} entries`;
  return result;
}

/** The legacy directory next to the current one, e.g. …/Application Support/local-chatgpt-agent. */
export function legacyUserDataPath(newUserData: string): string {
  return path.join(path.dirname(newUserData), LEGACY_USER_DATA_NAME);
}
