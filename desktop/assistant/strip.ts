// Pure rules behind the home window's status strip (#309): which language the
// assistant speaks and whether its hotkey collides with one Marshal already owns.

import { pickLanguage, type ReminderLanguage } from "../calendar/reminders.ts";

export type AssistantLanguageSetting = "auto" | "uk" | "en";

export function resolveAssistantLanguage(setting: AssistantLanguageSetting, preferred: readonly string[]): ReminderLanguage {
  return setting === "auto" ? pickLanguage(preferred) : setting;
}

export const DEFAULT_ASSISTANT_HOTKEY = "CommandOrControl+Alt+A";

/** `MARSHAL_ASSISTANT_HOTKEY`: an accelerator, or `off` for none. */
export function assistantHotkeyFromEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_ASSISTANT_HOTKEY;
  return trimmed.toLowerCase() === "off" ? null : trimmed;
}

const MODIFIER_ALIASES: Record<string, string> = {
  commandorcontrol: "cmd",
  cmdorctrl: "cmd",
  command: "cmd",
  cmd: "cmd",
  super: "cmd",
  meta: "cmd",
  control: "ctrl",
  ctrl: "ctrl",
  alt: "alt",
  option: "alt",
  altgr: "alt"
};

/**
 * Electron on macOS fires a shortcut for the same combo with an extra Shift
 * (measured, see #240), so Shift is left out: two accelerators that differ
 * only by it collide.
 */
export function acceleratorKey(accelerator: string): string {
  const parts = accelerator.split("+").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const modifiers = new Set<string>();
  let key = "";
  for (const part of parts) {
    if (part === "shift") continue;
    const modifier = MODIFIER_ALIASES[part];
    if (modifier) modifiers.add(modifier);
    else key = part;
  }
  return [...[...modifiers].sort(), key].join("+");
}

export function findAcceleratorConflict(candidate: string, taken: readonly string[]): string | null {
  const wanted = acceleratorKey(candidate);
  return taken.find((accelerator) => acceleratorKey(accelerator) === wanted) ?? null;
}
