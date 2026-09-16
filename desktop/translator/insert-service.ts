// desktop/translator/insert-service.ts
//
// "Insert" button: drop the finished translation into whatever app the user
// came from, the way DeepL's desktop app does. The translator window is the
// frontmost app while it is open, so the order matters:
//
//   1. snapshot the clipboard (the user's own content must survive this),
//   2. put the translation on it,
//   3. hide the translator — macOS hands focus back to the previous app,
//   4. wait for that focus change to actually land, then synthesize ⌘V,
//   5. restore the original clipboard.
//
// ⌘V is used rather than the AX-based insert-text helper because the target
// app is arbitrary: a self-signed helper has no per-binary Accessibility
// grant, so AX focused-element reads fail on many apps (see focus-paste.ts).
// CGEvent-posted ⌘V inherits the parent Electron process's trust.

import { clipboard } from "electron";

import { sendPasteKeystroke } from "../dictation/focus-paste.ts";

/** Time for macOS to make the previous app frontmost again after hide(). */
const FOCUS_SETTLE_MS = 220;
/** Time for the target app to read the clipboard before we restore it. */
const PASTE_COMMIT_MS = 180;

export interface InsertTranslationOptions {
  /** Hides the translator window so focus returns to the previous app. */
  hideWindow: () => void;
  /** Injected in tests. */
  paste?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export type InsertOutcome =
  | { ok: true }
  | { ok: false; reason: "empty" | "paste-failed"; message?: string };

/**
 * Pastes `text` into the app behind the translator. Never throws — the caller
 * turns the outcome into a UI state, and the clipboard still holds the
 * translation when the keystroke path fails, so the user can paste manually.
 */
export async function insertTranslation(
  text: string,
  options: InsertTranslationOptions
): Promise<InsertOutcome> {
  const payload = text.trim();
  if (!payload) return { ok: false, reason: "empty" };

  const paste = options.paste ?? (() => sendPasteKeystroke());
  const wait = options.sleep ?? defaultSleep;
  const original = clipboard.readText();

  clipboard.writeText(payload);
  options.hideWindow();
  await wait(FOCUS_SETTLE_MS);

  try {
    await paste();
  } catch (err) {
    // Leave the translation on the clipboard — a failed keystroke must not
    // also cost the user the text they were trying to insert.
    return {
      ok: false,
      reason: "paste-failed",
      message: err instanceof Error ? err.message : String(err)
    };
  }

  await wait(PASTE_COMMIT_MS);
  clipboard.writeText(original);
  return { ok: true };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
