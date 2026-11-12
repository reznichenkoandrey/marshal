// `./marshal reply` (#394): the owner's spoken answer typed into a session as
// the owner's own input. A message from another session never counts as the
// owner's approval, so a session that asked "archive this?" keeps waiting
// until the words arrive through its own input field.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FocusProbeResult } from "../dictation/focus-paste.ts";
import { findFocusTarget, parseProcessTable } from "./focus.ts";
import type { ClaudeSession } from "./registry.ts";

const execFileAsync = promisify(execFile);

// A terminal tab is in front at once; Claude desktop has to open the session first.
const TAB_SETTLE_MS = 300;
const DESKTOP_SETTLE_MS = 900;
const PASTE_SETTLE_MS = 150;

/** Why the words must not be typed into this session; null = go ahead. */
export function replyRefusal(session: Pick<ClaudeSession, "name" | "status"> | undefined, name: string): string | null {
  if (!session) return `No live session named "${name}".`;
  // A permission prompt or a question dialog takes keys, not text: Return would
  // pick its highlighted option whatever the owner said. The voice hook answers those (#375).
  if (session.status === "waiting") return `${session.name} shows a dialog; answer it there.`;
  if (session.status !== "idle") return `${session.name} is busy; try again when it stops.`;
  return null;
}

/**
 * Return only lands in the session when its host is in front with a text field
 * focused. Compared by bundle path: the app's name is localized ("Термінал").
 */
export function mayPressReturn(focus: FocusProbeResult, hostPath: string): boolean {
  return focus.isTextInput && hostPath !== "" && focus.frontmostPath === hostPath;
}

export type ReplyDeps = {
  /** Bundle path of the app that hosts the session. */
  hostApp: (pid: number) => Promise<string>;
  focusSession: (pid: number) => Promise<"tab" | "session" | "app" | null>;
  probe: () => Promise<FocusProbeResult>;
  writeClipboard: (text: string) => void;
  sendKey: (key: "v" | "return") => Promise<void>;
  activate: (app: string) => Promise<void>;
};

export async function hostAppOf(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,tty=,comm="]);
  const { appPath } = findFocusTarget(parseProcessTable(stdout), pid);
  return appPath ?? "";
}

/** Types `text` into the session and presses Return; returns what happened, for the dispatcher. */
export async function replyToSession(session: ClaudeSession, text: string, deps: ReplyDeps): Promise<string> {
  const before = (await deps.probe()).frontmostPath ?? "";
  const host = await deps.hostApp(session.pid);
  deps.writeClipboard(text);
  const shown = await deps.focusSession(session.pid);
  if (shown !== "tab" && shown !== "session") {
    return `Could not open ${session.name}; the reply is on the clipboard.`;
  }
  // AppleScript's `activate` sent from a background app does not take focus; LaunchServices does.
  if (host) await deps.activate(host);
  await new Promise((resolve) => setTimeout(resolve, shown === "tab" ? TAB_SETTLE_MS : DESKTOP_SETTLE_MS));
  if (!mayPressReturn(await deps.probe(), host)) {
    return `${session.name} is open but its input field is not focused; the reply is on the clipboard.`;
  }
  await deps.sendKey("v");
  // Rich composers apply a paste asynchronously; Return right after it can send an empty field.
  await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS));
  await deps.sendKey("return");
  if (before && before !== host) await deps.activate(before);
  return "ok";
}
