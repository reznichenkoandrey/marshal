// Adds Marshal's Stop / Notification hooks to ~/.claude/settings.json and
// takes them out again. The file belongs to the user and usually already holds
// their own hooks, so every change is a merge: Marshal's entries are found by
// the script name in their command and nothing else is touched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOOK_SCRIPT_NAME = "marshal-claude-hook.sh";
export const HOOK_EVENTS = ["Stop", "Notification"] as const;

type HookCommand = { type?: unknown; command?: unknown; [key: string]: unknown };
type HookGroup = { matcher?: unknown; hooks?: unknown; [key: string]: unknown };
type Settings = Record<string, unknown>;

export function defaultClaudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function hookCommand(scriptPath: string): string {
  return `/bin/sh '${scriptPath.replaceAll("'", "'\\''")}'`;
}

function isMarshalHook(hook: unknown): boolean {
  return typeof (hook as HookCommand)?.command === "string"
    && ((hook as HookCommand).command as string).includes(HOOK_SCRIPT_NAME);
}

function groupsOf(settings: Settings, event: string): unknown[] {
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return [];
  const groups = (hooks as Record<string, unknown>)[event];
  return Array.isArray(groups) ? groups : [];
}

export function hasMarshalHooks(settings: Settings): boolean {
  return HOOK_EVENTS.every((event) =>
    groupsOf(settings, event).some((group) => {
      const hooks = (group as HookGroup)?.hooks;
      return Array.isArray(hooks) && hooks.some(isMarshalHook);
    })
  );
}

/** Drop Marshal's commands; a group left with no commands goes with them. */
export function removeMarshalHooks(settings: Settings): Settings {
  if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) {
    return settings;
  }
  const hooks: Record<string, unknown> = { ...(settings.hooks as Record<string, unknown>) };
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = (hooks[event] as unknown[]).flatMap((group) => {
      const commands = (group as HookGroup)?.hooks;
      if (!Array.isArray(commands) || !commands.some(isMarshalHook)) return [group];
      const rest = commands.filter((hook) => !isMarshalHook(hook));
      return rest.length > 0 ? [{ ...(group as HookGroup), hooks: rest }] : [];
    });
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  const next: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

/** Idempotent: an existing Marshal entry is replaced, never duplicated. */
export function addMarshalHooks(settings: Settings, command: string): Settings {
  const base = removeMarshalHooks(settings);
  const hooks: Record<string, unknown> =
    typeof base.hooks === "object" && base.hooks !== null ? { ...(base.hooks as Record<string, unknown>) } : {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    // async: Claude Code does not wait for the script, so a slow or absent
    // Marshal never delays the session.
    hooks[event] = [...groups, { hooks: [{ type: "command", command, async: true }] }];
  }
  return { ...base, hooks };
}

function readSettings(filePath: string): { settings: Settings; indent: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, indent: "  " };
    throw err;
  }
  // A file we cannot parse is the user's to fix: rewriting it would lose it.
  const settings = JSON.parse(raw) as unknown;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error(`${filePath} is not a JSON object`);
  }
  const indent = /^[ \t]+(?=")/m.exec(raw)?.[0] ?? "  ";
  return { settings: settings as Settings, indent };
}

function writeSettings(filePath: string, settings: Settings, indent: string): void {
  // A dotfiles setup symlinks settings.json; replace the file it points to,
  // not the link, and keep its permissions.
  const target = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.marshal-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, indent)}\n`, { mode });
  fs.renameSync(tmp, target);
}

export function readHooksInstalled(filePath = defaultClaudeSettingsPath()): boolean {
  try {
    return hasMarshalHooks(readSettings(filePath).settings);
  } catch {
    return false;
  }
}

export function installHooks(scriptPath: string, filePath = defaultClaudeSettingsPath()): void {
  const { settings, indent } = readSettings(filePath);
  writeSettings(filePath, addMarshalHooks(settings, hookCommand(scriptPath)), indent);
}

export function uninstallHooks(filePath = defaultClaudeSettingsPath()): void {
  const { settings, indent } = readSettings(filePath);
  const next = removeMarshalHooks(settings);
  if (JSON.stringify(next) !== JSON.stringify(settings)) writeSettings(filePath, next, indent);
}
