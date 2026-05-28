// desktop/translator/clipboard-monitor.ts
// Detects double Cmd+C by listening to real keyboard events via uiohook-napi.
//
// Why not pasteboard watching? NSPasteboard.changeCount increments on ANY
// write — background apps (1Password, Raycast, Universal Clipboard, clipboard
// managers) frequently write in the background, so a single user ⌘C followed
// by an unrelated write inside the 600 ms window used to trigger the
// translator. Hooking the keyboard directly removes that entire class of
// false positives: only two real ⌘C keystrokes in a row open the popup.
//
// Also exposes the dedicated Cmd+Option+T global shortcut that always
// translates whatever is currently on the pasteboard, no double-copy needed.
// We use Option (Alt) rather than Shift here because Cmd+Shift+T is the
// "reopen closed tab" shortcut in Chrome/Safari — hijacking it globally
// broke that muscle memory for users. Cmd+Option+T is unassigned in both.
//
// Requires macOS Accessibility permission (shared with voice dictation).
// When it's missing, uiohook silently no-ops; the dedicated hotkey still
// works through Electron's globalShortcut.

import { clipboard, globalShortcut } from "electron";
import { EventEmitter } from "node:events";
import { UiohookKey, type UiohookKeyboardEvent, uIOhook } from "uiohook-napi";
import { acquireUiohook, type UiohookReleaseFn } from "../uiohook-lifecycle.ts";

const DOUBLE_COPY_WINDOW_MS = 600;
const POST_COPY_READ_DELAY_MS = 80;
const DEDICATED_HOTKEY = "CommandOrControl+Alt+T";
const EMIT_DEBOUNCE_MS = 400;

export class ClipboardMonitor extends EventEmitter {
  private readonly debug = process.env.MARSHAL_TRANSLATOR_DEBUG === "1";
  private lastCopyTs = 0;
  private lastEmitTime = 0;
  private hookRelease: UiohookReleaseFn | null = null;
  private pendingReadTimer: NodeJS.Timeout | null = null;

  // CRITICAL: any throw inside this handler propagates back through
  // uiohook-napi's `tsfn_to_js_proxy`, where `napi_call_function` returns
  // `napi_pending_exception` → `NAPI_FATAL_IF_FAILED` → `abort()` (SIGABRT).
  // Wrap the whole body so the native side never sees a JS exception.
  private readonly onKeyDown = (event: UiohookKeyboardEvent): void => {
    try {
      if (!this.isPlainCmdC(event)) return;

      const now = Date.now();
      const elapsed = now - this.lastCopyTs;

      if (this.debug) {
        console.log(`[ClipboardMonitor] ⌘C keydown elapsed=${elapsed}ms lastCopyTs=${this.lastCopyTs}`);
      }

      if (this.lastCopyTs > 0 && elapsed <= DOUBLE_COPY_WINDOW_MS) {
        // Second ⌘C within window. Reset state immediately so a third press
        // starts a fresh detection cycle, then defer the pasteboard read so
        // Cocoa's copy command has time to commit the new contents.
        this.lastCopyTs = 0;
        this.schedulePasteboardRead();
        return;
      }

      this.lastCopyTs = now;
    } catch (err) {
      console.error("[ClipboardMonitor] onKeyDown threw (suppressed to avoid napi abort):", err);
    }
  };

  start(): void {
    uIOhook.on("keydown", this.onKeyDown);
    if (!this.hookRelease) {
      // uiohook needs macOS Accessibility — when it's denied the native
      // helper throws `UIOHOOK_ERROR_AXAPI_DISABLED`. Catch it so the rest of
      // bootstrap (dictation toggle, globalShortcut registrations, the main
      // window) still come up. The user can still use the dedicated hotkey
      // (which is a globalShortcut) and the menu items. #82.
      try {
        this.hookRelease = acquireUiohook();
      } catch (err) {
        console.warn(
          "[ClipboardMonitor] uiohook unavailable (Accessibility denied?) — double-⌘C detector disabled:",
          err instanceof Error ? err.message : err
        );
        uIOhook.off("keydown", this.onKeyDown);
      }
    }

    globalShortcut.register(DEDICATED_HOTKEY, () => {
      const text = clipboard.readText().trim();
      if (text) this.safeEmit(text);
    });

    if (this.debug) {
      console.log("[ClipboardMonitor] double-⌘C detector armed via uiohook");
    }
  }

  stop(): void {
    uIOhook.off("keydown", this.onKeyDown);
    if (this.pendingReadTimer) {
      clearTimeout(this.pendingReadTimer);
      this.pendingReadTimer = null;
    }
    globalShortcut.unregister(DEDICATED_HOTKEY);
    this.hookRelease?.();
    this.hookRelease = null;
  }

  /** Returns true only when ⌘+C is pressed with no other modifier. */
  private isPlainCmdC(event: UiohookKeyboardEvent): boolean {
    if (event.keycode !== UiohookKey.C) return false;
    if (!event.metaKey) return false;
    if (event.shiftKey || event.ctrlKey || event.altKey) return false;
    return true;
  }

  private schedulePasteboardRead(): void {
    if (this.pendingReadTimer) {
      clearTimeout(this.pendingReadTimer);
    }
    this.pendingReadTimer = setTimeout(() => {
      this.pendingReadTimer = null;
      const text = clipboard.readText().trim();
      if (text) this.safeEmit(text);
    }, POST_COPY_READ_DELAY_MS);
  }

  /** Emit with debounce so rapid keystrokes can't stack duplicate translations. */
  private safeEmit(text: string): void {
    const now = Date.now();
    if (now - this.lastEmitTime < EMIT_DEBOUNCE_MS) return;
    this.lastEmitTime = now;
    if (this.debug) {
      console.log("[ClipboardMonitor] → translate:", text.slice(0, 40));
    }
    this.emit("translate", text);
  }
}
