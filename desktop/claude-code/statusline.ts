// Wraps the user's Claude Code statusline command so Marshal can record the
// per-session JSON (context %, cost, rate limits) without changing what the
// user sees. The wrapper runs on Claude Code's own statusline refresh, so
// nothing here polls (#281). Every settings edit is a merge, like hook-installer.

import fs from "node:fs";
import path from "node:path";

import { defaultClaudeSettingsPath, hookCommand, readSettings, writeSettings } from "./hook-installer.ts";

export const STATUSLINE_SCRIPT_NAME = "marshal-statusline.sh";
// Holds the statusline value that was in settings before Marshal wrapped it.
export const PREVIOUS_STATUSLINE_FILE = "previous-statusline.json";

type Settings = Record<string, unknown>;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function isMarshalStatusLine(value: unknown): boolean {
  const command = (value as { command?: unknown } | null)?.command;
  return typeof command === "string" && command.includes(STATUSLINE_SCRIPT_NAME);
}

function commandOf(value: unknown): string | null {
  const command = (value as { command?: unknown } | null)?.command;
  return typeof command === "string" && command.length > 0 ? command : null;
}

/** Sets Marshal's wrapper as the statusline. Already wrapped → unchanged. */
export function wrapStatusLine(settings: Settings, wrapperCommand: string): Settings {
  if (isMarshalStatusLine(settings.statusLine)) return settings;
  return { ...settings, statusLine: { type: "command", command: wrapperCommand } };
}

/**
 * Puts back the exact statusline value saved before wrapping. `previous` null
 * means there was none. A statusline the user changed since is left alone.
 */
export function unwrapStatusLine(settings: Settings, previous: unknown | null): Settings {
  if (!isMarshalStatusLine(settings.statusLine)) return settings;
  const next = { ...settings };
  if (previous === null || previous === undefined) delete next.statusLine;
  else next.statusLine = previous;
  return next;
}

/**
 * The wrapper: stores stdin (the statusline JSON) as <usageDir>/<session_id>.json,
 * then pipes the same stdin to the previous command and lets its output through.
 * The previous command is baked in at install time; reinstall after changing it.
 */
export function buildUsageWrapper(usageDir: string, previousCommand: string | null): string {
  const chained = previousCommand === null
    ? ""
    : `printf '%s' "$input" | /bin/sh -c ${shellQuote(previousCommand)}\n`;
  return `#!/bin/sh
# Written by Marshal. Records the statusline JSON, then runs the previous statusline.
usage_dir=${shellQuote(usageDir)}
input=$(cat)
session=$(printf '%s' "$input" | sed -n 's/.*"session_id" *: *"\\([A-Za-z0-9_-]*\\)".*/\\1/p' | head -n 1)
if [ -n "$session" ]; then
  printf '%s' "$input" > "$usage_dir/$session.json.tmp" && mv "$usage_dir/$session.json.tmp" "$usage_dir/$session.json"
fi
${chained}`;
}

function writeFileAtomic(filePath: string, content: string, mode: number): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, filePath);
}

function readPrevious(usageDir: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(usageDir, PREVIOUS_STATUSLINE_FILE), "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function installStatusLine(usageDir: string, settingsPath = defaultClaudeSettingsPath()): void {
  const { settings, indent } = readSettings(settingsPath);
  const alreadyWrapped = isMarshalStatusLine(settings.statusLine);
  // Keep the original value from the first install; a second install must not save Marshal's own wrapper.
  const previous = alreadyWrapped ? readPrevious(usageDir) : (settings.statusLine ?? null);
  fs.mkdirSync(usageDir, { recursive: true });
  const wrapperPath = path.join(usageDir, STATUSLINE_SCRIPT_NAME);
  writeFileAtomic(wrapperPath, buildUsageWrapper(usageDir, commandOf(previous)), 0o700);
  if (!alreadyWrapped) writeFileAtomic(path.join(usageDir, PREVIOUS_STATUSLINE_FILE), JSON.stringify(previous), 0o600);
  writeSettings(settingsPath, wrapStatusLine(settings, hookCommand(wrapperPath)), indent);
}

export function uninstallStatusLine(usageDir: string, settingsPath = defaultClaudeSettingsPath()): void {
  const { settings, indent } = readSettings(settingsPath);
  if (!isMarshalStatusLine(settings.statusLine)) return;
  writeSettings(settingsPath, unwrapStatusLine(settings, readPrevious(usageDir)), indent);
  fs.rmSync(path.join(usageDir, STATUSLINE_SCRIPT_NAME), { force: true });
  fs.rmSync(path.join(usageDir, PREVIOUS_STATUSLINE_FILE), { force: true });
}
