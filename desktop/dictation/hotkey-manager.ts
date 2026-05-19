// desktop/dictation/hotkey-manager.ts
// Wraps uiohook-napi to provide push-to-talk style "hold to record" semantics.
//
// The Electron `globalShortcut` module only fires on keydown, with no release
// event. uiohook gives us both, which is what we need to emit "start" at
// keydown and "stop" at keyup. Accessibility permission is already requested
// by the clipboard monitor, so no additional prompt.

import { EventEmitter } from "node:events";
import { UiohookKey, type UiohookKeyboardEvent, uIOhook } from "uiohook-napi";
import { acquireUiohook, type UiohookReleaseFn } from "../uiohook-lifecycle.ts";

export type HotkeySpec = {
  keycode: number;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
};

const MODIFIER_TOKENS = new Set([
  "cmd", "command", "meta", "super",
  "ctrl", "control",
  "alt", "option", "opt",
  "shift"
]);

// Aliases that resolve to a specific physical modifier key used as the TARGET
// of the hotkey (e.g. "RightCmd" alone is a valid push-to-talk trigger).
const KEY_ALIASES: Record<string, keyof typeof UiohookKey> = {
  rightcmd: "MetaRight",
  rcmd: "MetaRight",
  rightcommand: "MetaRight",
  cmdright: "MetaRight",
  commandright: "MetaRight",
  leftcmd: "Meta",
  lcmd: "Meta",
  leftcommand: "Meta",
  cmdleft: "Meta",
  commandleft: "Meta",
  rightshift: "ShiftRight",
  rshift: "ShiftRight",
  leftshift: "Shift",
  lshift: "Shift",
  rightctrl: "CtrlRight",
  rctrl: "CtrlRight",
  leftctrl: "Ctrl",
  lctrl: "Ctrl",
  rightalt: "AltRight",
  ralt: "AltRight",
  leftalt: "Alt",
  lalt: "Alt",
  rightoption: "AltRight",
  roption: "AltRight",
  leftoption: "Alt",
  loption: "Alt"
};

// Keycodes that ARE modifiers. When one of these is the hotkey's target key,
// its corresponding modifier flag in the event stream should be ignored
// during matching (pressing right-Cmd naturally raises metaKey=true).
const META_KEYCODES = new Set<number>([UiohookKey.Meta, UiohookKey.MetaRight]);
const SHIFT_KEYCODES = new Set<number>([UiohookKey.Shift, UiohookKey.ShiftRight]);
const CTRL_KEYCODES = new Set<number>([UiohookKey.Ctrl, UiohookKey.CtrlRight]);
const ALT_KEYCODES = new Set<number>([UiohookKey.Alt, UiohookKey.AltRight]);

/**
 * Parses strings like "Cmd+Shift+D" into the modifier-flag + keycode shape
 * uiohook keyboard events use. Accepts mac-style aliases (Cmd, Option,
 * Control) as well as platform-neutral names (Meta, Alt, Ctrl).
 */
export function parseHotkey(raw: string): HotkeySpec {
  const spec: HotkeySpec = { keycode: 0, meta: false, ctrl: false, alt: false, shift: false };
  const parts = raw.split("+").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIER_TOKENS.has(lower)) {
      if (lower === "cmd" || lower === "command" || lower === "meta" || lower === "super") {
        spec.meta = true;
      } else if (lower === "ctrl" || lower === "control") {
        spec.ctrl = true;
      } else if (lower === "alt" || lower === "option" || lower === "opt") {
        spec.alt = true;
      } else if (lower === "shift") {
        spec.shift = true;
      }
      continue;
    }
    const aliased = KEY_ALIASES[lower];
    const keyName = aliased ?? resolveKeyName(part);
    const code = (UiohookKey as Record<string, number>)[keyName];
    if (typeof code !== "number") {
      throw new Error(`Unknown key "${part}" in hotkey "${raw}"`);
    }
    if (spec.keycode !== 0) {
      throw new Error(`Hotkey "${raw}" has more than one target key`);
    }
    spec.keycode = code;
  }
  if (spec.keycode === 0) {
    throw new Error(`Hotkey "${raw}" is missing a target key`);
  }
  return spec;
}

function resolveKeyName(token: string): string {
  if (token.length === 1) return token.toUpperCase();
  // e.g. "F1" → "F1", "space" → "Space"
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

export function matchesHotkey(event: UiohookKeyboardEvent, spec: HotkeySpec): boolean {
  if (event.keycode !== spec.keycode) return false;
  // If the target itself is a modifier key, ignore its own modifier flag —
  // pressing right-Cmd makes event.metaKey=true, which is expected, not a
  // disqualifying "extra" modifier.
  if (!META_KEYCODES.has(spec.keycode) && event.metaKey !== spec.meta) return false;
  if (!SHIFT_KEYCODES.has(spec.keycode) && event.shiftKey !== spec.shift) return false;
  if (!CTRL_KEYCODES.has(spec.keycode) && event.ctrlKey !== spec.ctrl) return false;
  if (!ALT_KEYCODES.has(spec.keycode) && event.altKey !== spec.alt) return false;
  return true;
}

export type HotkeyManagerEvents = {
  "hold-start": [];
  "hold-end": [];
};

export class PushToTalkHotkey extends EventEmitter {
  private readonly spec: HotkeySpec;
  private readonly debug: boolean;
  private started = false;
  private holding = false;
  private hookRelease: UiohookReleaseFn | null = null;
  private downHandler: (event: UiohookKeyboardEvent) => void;
  private upHandler: (event: UiohookKeyboardEvent) => void;

  constructor(hotkey: string) {
    super();
    this.spec = parseHotkey(hotkey);
    this.debug = process.env.MARSHAL_DICTATION_DEBUG === "1";
    this.downHandler = (event) => {
      if (event.keycode === this.spec.keycode && this.debug) {
        console.log(
          `[dictation] keydown keycode=${event.keycode} meta=${event.metaKey} ctrl=${event.ctrlKey} alt=${event.altKey} shift=${event.shiftKey} holding=${this.holding}`
        );
      }
      if (this.holding) return;
      if (!matchesHotkey(event, this.spec)) return;
      this.holding = true;
      this.emit("hold-start");
    };
    // Keyup fires with the modifier possibly already released by the user,
    // so for the release event we only check the target key.
    this.upHandler = (event) => {
      if (event.keycode === this.spec.keycode && this.debug) {
        console.log(
          `[dictation] keyup   keycode=${event.keycode} meta=${event.metaKey} ctrl=${event.ctrlKey} alt=${event.altKey} shift=${event.shiftKey} holding=${this.holding}`
        );
      }
      if (!this.holding) return;
      if (event.keycode !== this.spec.keycode) return;
      this.holding = false;
      this.emit("hold-end");
    };
  }

  /**
   * Force-end the hold from outside (used by the service as a safety-net
   * timeout when the keyup event never arrives — see #49).
   */
  forceEnd(): void {
    if (!this.holding) return;
    this.holding = false;
    this.emit("hold-end");
  }

  start(): void {
    if (this.started) return;
    uIOhook.on("keydown", this.downHandler);
    uIOhook.on("keyup", this.upHandler);
    this.hookRelease = acquireUiohook();
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    uIOhook.off("keydown", this.downHandler);
    uIOhook.off("keyup", this.upHandler);
    this.hookRelease?.();
    this.hookRelease = null;
    this.started = false;
    this.holding = false;
  }
}
