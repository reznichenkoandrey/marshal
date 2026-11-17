// Opens a new Claude desktop session (#437): Claude.app's own deep link
// prefills the composer with the prompt in the given folder; Marshal then
// presses Return the way `./marshal reply` does (#394). The session gets the
// app's model and permission mode, not the caller's (#448, below).

import type { GeneralPermissionMode } from "../assistant/dispatcher-files.ts";
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

// Neither the deep link, the folder's settings (the app passes `--model` and
// `--permission-mode` to the CLI) nor the session itself (`set_session_model`
// refuses its own session) can set these from outside (#448): Marshal reads
// what the session actually runs on and tells the owner which menu to change.
export type SessionSetup = { model: string | null; permissionMode: string | null };

/** The model of the last answer and the permission mode of the last user turn, from transcript lines. */
export function readSessionSetup(transcript: string): SessionSetup {
  let model: string | null = null;
  let permissionMode: string | null = null;
  const lines = transcript.split("\n");
  for (let index = lines.length - 1; index >= 0 && (!model || !permissionMode); index -= 1) {
    let entry: { type?: unknown; permissionMode?: unknown; message?: { model?: unknown } };
    try {
      entry = JSON.parse(lines[index]!) as typeof entry;
    } catch {
      continue;
    }
    const answered = entry?.message?.model;
    // "<synthetic>" marks an API error, not a model.
    if (!model && entry?.type === "assistant" && typeof answered === "string" && !answered.startsWith("<")) model = answered;
    if (!permissionMode && entry?.type === "user" && typeof entry.permissionMode === "string") permissionMode = entry.permissionMode;
  }
  return { model, permissionMode };
}

const MODE_IDS: Record<GeneralPermissionMode, string> = { bypass: "bypassPermissions", auto: "auto", default: "default" };
const MODE_LABELS: Record<GeneralPermissionMode, string> = { bypass: "Bypass permissions", auto: "Auto", default: "Ask permissions" };

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** "claude-opus-5-5" → "Opus 5.5", "haiku" → "Haiku": the way the app's model menu reads. */
function modelLabel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/u.exec(model);
  if (!match) return capitalize(model);
  return match[3] ? `${capitalize(match[1]!)} ${match[2]}.${match[3]}` : `${capitalize(match[1]!)} ${match[2]}`;
}

/** What to tell the owner when the session runs on another model or mode than Settings ask for; null when it matches or is unknown. */
export function setupMismatch(setup: SessionSetup, wantedModel: string, wantedMode: GeneralPermissionMode): string | null {
  const wanted = (wantedModel || "haiku").toLowerCase();
  const fixes: string[] = [];
  if (setup.model && !setup.model.toLowerCase().includes(wanted)) {
    fixes.push(`модель ${modelLabel(setup.model)} замість ${modelLabel(wanted)}`);
  }
  if (setup.permissionMode && setup.permissionMode !== MODE_IDS[wantedMode]) fixes.push(`режим дозволів не ${MODE_LABELS[wantedMode]}`);
  if (fixes.length === 0) return null;
  return `Диспетчер у застосунку Claude має ${fixes.join(" і ")}. Перемкни це в меню під полем вводу його сесії, один раз.`;
}
