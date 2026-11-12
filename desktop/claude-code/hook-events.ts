// What a Claude Code hook payload means for Marshal, and the rules for the
// spool the hook script writes while Marshal is not running. Pure, so the
// parsing and the replay/dedup rules are pinned by tests.

import { createHash } from "node:crypto";

export type HookEvent =
  | { type: "stop"; sessionId: string; cwd: string; lastMessage: string }
  | { type: "attention"; sessionId: string; cwd: string; reason: "confirmation" | "input"; message: string };

// notification_type values from Claude Code 2.1.317. idle_prompt is left out
// on purpose: it repeats a Stop the user was already told about.
const CONFIRMATION_TYPES = new Set(["permission_prompt", "worker_permission_prompt"]);
const INPUT_TYPES = new Set(["elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

export const SPOOL_MAX_AGE_MS = 15 * 60_000;
export const WAITING_REMINDER_MS = 10 * 60_000;

export function parseHookPayload(raw: string): HookEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const o = data as Record<string, unknown>;
  if (typeof o.session_id !== "string" || o.session_id === "") return null;
  const cwd = typeof o.cwd === "string" ? o.cwd : "";

  if (o.hook_event_name === "Stop") {
    return {
      type: "stop",
      sessionId: o.session_id,
      cwd,
      lastMessage: typeof o.last_assistant_message === "string" ? o.last_assistant_message : ""
    };
  }
  if (o.hook_event_name === "Notification" && typeof o.notification_type === "string") {
    const reason = CONFIRMATION_TYPES.has(o.notification_type)
      ? "confirmation"
      : INPUT_TYPES.has(o.notification_type) ? "input" : null;
    if (!reason) return null;
    return {
      type: "attention",
      sessionId: o.session_id,
      cwd,
      reason,
      message: typeof o.message === "string" ? o.message : ""
    };
  }
  return null;
}

/**
 * The same event reaches Marshal byte-for-byte whether it was posted or
 * spooled (the script spools only what it failed to post), so session id plus
 * a hash of the payload identifies it — the transcript moves on before a
 * replay, so its last uuid would not.
 */
export function eventKey(sessionId: string, raw: string): string {
  return `${sessionId}:${createHash("sha256").update(raw).digest("hex")}`;
}

export class EventDeduper {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = SPOOL_MAX_AGE_MS) {}

  /** True the first time a key is offered within the TTL. */
  accept(key: string, now: number): boolean {
    for (const [k, at] of this.seen) if (now - at > this.ttlMs) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }
}

export function isFreshSpoolEntry(mtimeMs: number, now: number): boolean {
  return now - mtimeMs <= SPOOL_MAX_AGE_MS;
}

/** One line for the notification: the answer itself when it already is one. */
export function shortAnswer(text: string, maxChars = 140): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.includes("\n") || trimmed.length > maxChars) return null;
  return trimmed;
}

export function looksUkrainian(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  const cyrillic = letters.filter((ch) => /\p{Script=Cyrillic}/u.test(ch)).length;
  return letters.length > 0 && cyrillic / letters.length > 0.3;
}

/**
 * The script Claude Code runs for each hook. It posts the event to Marshal on
 * loopback with the per-run token and, when that fails (Marshal not running,
 * stale port), writes it to the spool for the next start. Plain sh + curl:
 * both ship with macOS, and the hook must not depend on Node being on PATH.
 */
export function buildHookScript(hookDir: string): string {
  const dir = `'${hookDir.replaceAll("'", "'\\''")}'`;
  return [
    "#!/bin/sh",
    "# Marshal: forwards a Claude Code hook event to Marshal; spools it when Marshal is not running.",
    `dir=${dir}`,
    "payload=$(cat)",
    "# PermissionRequest (#375): Marshal may answer by voice. Its reply is the hook's stdout;",
    "# anything else (not running, no answer) prints nothing and the usual prompt shows.",
    "if [ \"$1\" = permission ]; then",
    "  [ -r \"$dir/port\" ] && [ -r \"$dir/auth-header\" ] || exit 0",
    "  printf '%s' \"$payload\" | curl -sf -m 58 -H 'Content-Type: application/json' \\",
    "    -H @\"$dir/auth-header\" --data-binary @- \"http://127.0.0.1:$(cat \"$dir/port\")/claude-code/permission\"",
    "  exit 0",
    "fi",
    "if [ -r \"$dir/port\" ] && [ -r \"$dir/auth-header\" ]; then",
    "  port=$(cat \"$dir/port\")",
    "  if printf '%s' \"$payload\" | curl -sf -m 3 -o /dev/null -H 'Content-Type: application/json' \\",
    "    -H @\"$dir/auth-header\" --data-binary @- \"http://127.0.0.1:$port/claude-code/hook\"; then",
    "    exit 0",
    "  fi",
    "fi",
    "mkdir -p \"$dir/spool\"",
    "tmp=\"$dir/spool/.$$.tmp\"",
    "printf '%s' \"$payload\" > \"$tmp\" && mv \"$tmp\" \"$dir/spool/$(date +%s)-$$.json\"",
    ""
  ].join("\n");
}
