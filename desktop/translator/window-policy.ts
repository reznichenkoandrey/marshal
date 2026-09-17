// desktop/translator/window-policy.ts
//
// When the translator window may disappear, and what its hotkey does.
//
// Both rules used to be one-liners buried in the window and the clipboard
// monitor, and both were wrong in the same way: they treated "lost focus" and
// "user pressed the hotkey" as having a single meaning, when each has two.
// See #166.
//
// No Electron import — this is policy, and it is the part worth testing.

export interface BlurContext {
  /** The user pinned the window: blur is normal while they work elsewhere. */
  pinned: boolean;
  /** The source field holds text — a translation in progress. */
  hasContent: boolean;
}

/**
 * `blur` does not mean "the user dismissed this". It also fires for a
 * notification, an app launching, a system dialog — none of which are a
 * decision to throw away what is being typed. So an empty window stays a
 * glance tool and vanishes, while one with text in it stays put; `Esc`, the
 * close button and Clear remain the explicit ways out.
 */
export function shouldHideOnBlur(context: BlurContext): boolean {
  if (context.pinned) return false;
  return !context.hasContent;
}

export type TranslatorHotkeyAction = "hide" | "show" | "translate-clipboard";

export interface HotkeyContext {
  visible: boolean;
  /** Visible but behind another window is a different situation from focused. */
  focused: boolean;
  hasContent: boolean;
  clipboardText: string;
}

/**
 * The dedicated hotkey used to mean exactly "translate the clipboard", which
 * left it doing nothing at all when the clipboard was empty, and clobbering
 * half-typed text when it was not. It now resolves to whatever the user can
 * only have meant:
 *
 *   visible and focused → they want it gone
 *   visible behind something → they want it in front
 *   hidden with text waiting → bring that back, do not overwrite it
 *   hidden and empty → the original behaviour, translate the clipboard
 *   hidden, empty, nothing copied → still show the window; a global hotkey
 *     that silently does nothing is indistinguishable from a broken one
 */
export function decideHotkeyAction(context: HotkeyContext): TranslatorHotkeyAction {
  if (context.visible) return context.focused ? "hide" : "show";
  if (context.hasContent) return "show";
  return context.clipboardText.trim() ? "translate-clipboard" : "show";
}
