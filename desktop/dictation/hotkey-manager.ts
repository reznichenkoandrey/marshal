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
import {
  isSwiftPttCandidate,
  SwiftPushToTalkHotkey
} from "./swift-ptt-monitor.ts";

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
  // Emitted when uiohook attaches successfully but no keydown event lands
  // within SILENCE_PROBE_MS. Almost always indicates Input Monitoring is not
  // granted to this build (TCC reset after self-signed bundle replace — #84)
  // OR macOS Dictation has claimed the same key at the CGEventTap layer
  // (#97). Main process surfaces this as a user-facing notification (#100).
  "input-monitoring-silent": [];
};

// How long to wait for ANY keyboard event after uiohook is acquired before
// declaring the OS silent on us. 5s is long enough to avoid false positives
// on a user who has briefly stepped away from the keyboard, short enough to
// be actionable on the first real session.
const SILENCE_PROBE_MS = 5_000;

/**
 * Common minimum surface for any push-to-talk backend. Both uiohook-based
 * PushToTalkHotkey and the Swift-helper SwiftPushToTalkHotkey conform — so
 * the dictation service can hold the union type without caring which path
 * is active under it.
 */
export interface PushToTalkBackend extends EventEmitter {
  start(): void;
  stop(): void;
  forceEnd(): void;
}

/**
 * Pick the right backend for the user's hotkey choice. Modifier-only
 * triggers (RightCmd, LeftShift, etc.) route to the Swift `ptt-monitor`
 * helper because uiohook's CGEventTap is unreliable for modifiers on
 * self-signed Sequoia bundles (Input Monitoring TCC silently drops key
 * events even when granted; see swift-ptt-monitor.ts for the long story).
 * Anything else — multi-key chords, letter targets, function keys — keeps
 * using uiohook, which doesn't have the modifier-specific issue.
 *
 * Override via MARSHAL_DICTATION_FORCE_UIOHOOK=1 if you need to compare
 * paths or the Swift helper is unavailable.
 */
export function createPushToTalkHotkey(hotkey: string): PushToTalkBackend {
  const force = process.env.MARSHAL_DICTATION_FORCE_UIOHOOK === "1";
  if (!force && isSwiftPttCandidate(hotkey)) {
    return new SwiftPushToTalkHotkey(hotkey);
  }
  return new PushToTalkHotkey(hotkey);
}

export class PushToTalkHotkey extends EventEmitter implements PushToTalkBackend {
  private readonly spec: HotkeySpec;
  private readonly debug: boolean;
  private started = false;
  private holding = false;
  private hookRelease: UiohookReleaseFn | null = null;
  private downHandler: (event: UiohookKeyboardEvent) => void;
  private upHandler: (event: UiohookKeyboardEvent) => void;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(hotkey: string) {
    super();
    this.spec = parseHotkey(hotkey);
    this.debug = process.env.MARSHAL_DICTATION_DEBUG === "1";
    // CRITICAL: any throw inside these handlers propagates back through
    // uiohook-napi's `tsfn_to_js_proxy`, where `napi_call_function` returns
    // `napi_pending_exception` → `NAPI_FATAL_IF_FAILED` → `abort()` (SIGABRT).
    // Listeners on `hold-start`/`hold-end` (e.g. spawning the audio recorder)
    // can throw synchronously, so every uiohook callback gets a top-level
    // try/catch — the native side must never see a JS exception.
    this.downHandler = (event) => {
      try {
        if (event.keycode === this.spec.keycode && this.debug) {
          console.log(
            `[dictation] keydown keycode=${event.keycode} meta=${event.metaKey} ctrl=${event.ctrlKey} alt=${event.altKey} shift=${event.shiftKey} holding=${this.holding}`
          );
        }
        if (this.holding) return;
        if (!matchesHotkey(event, this.spec)) return;
        this.holding = true;
        this.emit("hold-start");
      } catch (err) {
        console.error("[dictation] downHandler threw (suppressed to avoid napi abort):", err);
      }
    };
    // Keyup fires with the modifier possibly already released by the user,
    // so for the release event we only check the target key.
    this.upHandler = (event) => {
      try {
        if (event.keycode === this.spec.keycode && this.debug) {
          console.log(
            `[dictation] keyup   keycode=${event.keycode} meta=${event.metaKey} ctrl=${event.ctrlKey} alt=${event.altKey} shift=${event.shiftKey} holding=${this.holding}`
          );
        }
        if (!this.holding) return;
        if (event.keycode !== this.spec.keycode) return;
        this.holding = false;
        this.emit("hold-end");
      } catch (err) {
        console.error("[dictation] upHandler threw (suppressed to avoid napi abort):", err);
      }
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
    console.log(`[hotkey] start() keycode=${this.spec.keycode} meta=${this.spec.meta} ctrl=${this.spec.ctrl} alt=${this.spec.alt} shift=${this.spec.shift}`);

    // Catch-all probes. If uiohook's event loop is alive at all, we'll see
    // *any* keydown / mousemove line in the log. Silence under these means
    // the native CGEventTap was created but is not receiving events — almost
    // always a macOS Sequoia uiohook-napi compatibility issue rather than a
    // TCC permission gate (which would have failed acquireUiohook()).
    let firstKey = true;
    let firstMouse = true;
    const probeKey = (e: UiohookKeyboardEvent) => {
      if (firstKey) {
        console.log(`[hotkey][probe] FIRST keydown received keycode=${e.keycode}`);
        firstKey = false;
        // First key landed — the OS is delivering events, no need to warn.
        if (this.silenceTimer) {
          clearTimeout(this.silenceTimer);
          this.silenceTimer = null;
        }
      }
    };
    const probeMouse = () => {
      if (firstMouse) {
        console.log(`[hotkey][probe] FIRST mousemove received`);
        firstMouse = false;
      }
    };
    uIOhook.on("keydown", probeKey);
    uIOhook.on("mousemove", probeMouse);

    uIOhook.on("keydown", this.downHandler);
    uIOhook.on("keyup", this.upHandler);
    try {
      this.hookRelease = acquireUiohook();
      console.log("[hotkey] acquireUiohook() ok");
      this.started = true;
      // Silence-probe: uiohook attached without throwing, but on macOS that
      // doesn't guarantee the OS is actually delivering events to us. Common
      // cause: Input Monitoring grant was wiped by a self-signed bundle
      // replace (#84); rarer cause: macOS Dictation has the same key at a
      // lower layer (#97). If we don't see ANY keydown in SILENCE_PROBE_MS,
      // assume we're deaf and emit so the main process can show a user-
      // actionable notification (#100).
      this.silenceTimer = setTimeout(() => {
        this.silenceTimer = null;
        if (firstKey) {
          console.warn(
            `[hotkey] no keydown events in ${SILENCE_PROBE_MS}ms — ` +
              "Input Monitoring is probably not granted, or another " +
              "system feature owns the target key"
          );
          this.emit("input-monitoring-silent");
        }
      }, SILENCE_PROBE_MS);
    } catch (err) {
      // uiohook needs macOS Accessibility — when it's denied the native helper
      // throws UIOHOOK_ERROR_AXAPI_DISABLED. Swallow it here so dictation can
      // still be triggered via the globalShortcut toggle and the tray menu
      // (neither of which goes through uiohook). #82.
      console.warn(
        "[hotkey] acquireUiohook() failed — hold-to-talk disabled, use Cmd+Alt+M toggle or tray menu instead:",
        err instanceof Error ? err.message : err
      );
      uIOhook.off("keydown", this.downHandler);
      uIOhook.off("keyup", this.upHandler);
      uIOhook.off("keydown", probeKey);
      uIOhook.off("mousemove", probeMouse);
    }
  }

  stop(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (!this.started) return;
    uIOhook.off("keydown", this.downHandler);
    uIOhook.off("keyup", this.upHandler);
    this.hookRelease?.();
    this.hookRelease = null;
    this.started = false;
    this.holding = false;
  }
}
