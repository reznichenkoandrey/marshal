// Opens a new Claude desktop session (#437): Claude.app's own deep link
// prefills the composer with the prompt in the given folder; Marshal then
// presses Return the way `./marshal reply` does (#394). The session gets the
// app's model and permission mode, not the caller's.

import type { FocusProbeResult } from "../dictation/focus-paste.ts";
import { mayPressReturn } from "./reply.ts";

export const CLAUDE_APP = "/Applications/Claude.app";
// The app may be cold: it has to come up and render the new-session view.
const OPEN_SETTLE_MS = 1_500;
const OPEN_RETRY_MS = 1_000;
const OPEN_ATTEMPTS = 4;

export function newSessionUrl(cwd: string, prompt: string): string {
  const query = new URLSearchParams({ q: prompt, folder: cwd });
  return `claude://code/new?${query.toString()}`;
}

export type DesktopSessionDeps = {
  openUrl: (url: string) => Promise<void>;
  probe: () => Promise<FocusProbeResult>;
  sendKey: (key: "return") => Promise<void>;
  activate: (app: string) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
};

/**
 * "ok" once Return went into Claude's composer; otherwise why not, with the
 * prompt left in the composer for the owner to send. `reveal` false returns
 * the owner to the app they were in.
 */
export async function openDesktopSession(cwd: string, prompt: string, reveal: boolean, deps: DesktopSessionDeps): Promise<string> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const before = (await deps.probe()).frontmostPath ?? "";
  await deps.openUrl(newSessionUrl(cwd, prompt));
  await wait(OPEN_SETTLE_MS);
  let last: FocusProbeResult | null = null;
  for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt += 1) {
    last = await deps.probe();
    if (mayPressReturn(last, CLAUDE_APP)) {
      await deps.sendKey("return");
      if (!reveal && before && before !== CLAUDE_APP) await deps.activate(before);
      return "ok";
    }
    await wait(OPEN_RETRY_MS);
  }
  return `Claude opened the session, but its input field is not focused; press Return there. (frontmost: ${last?.frontmostPath ?? "?"}, text input: ${last?.isTextInput ?? "?"}, role: ${last?.role ?? "?"})`;
}
