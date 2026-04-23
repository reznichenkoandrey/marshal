// desktop/dictation/hotkey-manager.ts
// Wraps uiohook-napi to provide push-to-talk style "hold to record" semantics.
//
// The Electron `globalShortcut` module only fires on keydown, with no release
// event. uiohook gives us both, which is what we need to emit "start" at
// keydown and "stop" at keyup. Accessibility permission is already requested
// by the clipboard monitor, so no additional prompt.

import { EventEmitter } from "node:events";
import { uIOhook, UiohookKey, type UiohookKeyboardEvent } from "uiohook-napi";

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
    const keyName = resolveKeyName(part);
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
  return (
    event.keycode === spec.keycode &&
    event.metaKey === spec.meta &&
    event.ctrlKey === spec.ctrl &&
    event.altKey === spec.alt &&
    event.shiftKey === spec.shift
  );
}

export type HotkeyManagerEvents = {
  "hold-start": [];
  "hold-end": [];
};

export class PushToTalkHotkey extends EventEmitter {
  private readonly spec: HotkeySpec;
  private started = false;
  private holding = false;
  private downHandler: (event: UiohookKeyboardEvent) => void;
  private upHandler: (event: UiohookKeyboardEvent) => void;

  constructor(hotkey: string) {
    super();
    this.spec = parseHotkey(hotkey);
    this.downHandler = (event) => {
      if (this.holding) return;
      if (!matchesHotkey(event, this.spec)) return;
      this.holding = true;
      this.emit("hold-start");
    };
    // Keyup fires with the modifier possibly already released by the user,
    // so for the release event we only check the target key.
    this.upHandler = (event) => {
      if (!this.holding) return;
      if (event.keycode !== this.spec.keycode) return;
      this.holding = false;
      this.emit("hold-end");
    };
  }

  start(): void {
    if (this.started) return;
    uIOhook.on("keydown", this.downHandler);
    uIOhook.on("keyup", this.upHandler);
    uIOhook.start();
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    uIOhook.off("keydown", this.downHandler);
    uIOhook.off("keyup", this.upHandler);
    // Don't call uIOhook.stop() here — other consumers (e.g. clipboard
    // monitor) may still need the hook running. uiohook handles zero-listener
    // state fine.
    this.started = false;
    this.holding = false;
  }
}
