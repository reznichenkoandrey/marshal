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
// Also exposes the dedicated Cmd+Shift+T global shortcut that always
// translates whatever is currently on the pasteboard, no double-copy needed.
//
// Requires macOS Accessibility permission (shared with voice dictation).
// When it's missing, uiohook silently no-ops; the dedicated hotkey still
// works through Electron's globalShortcut.

import { clipboard, globalShortcut } from "electron";
import { EventEmitter } from "node:events";
import { uIOhook, UiohookKey, type UiohookKeyboardEvent } from "uiohook-napi";

const DOUBLE_COPY_WINDOW_MS = 600;
const POST_COPY_READ_DELAY_MS = 80;
const DEDICATED_HOTKEY = "CommandOrControl+Shift+T";
const EMIT_DEBOUNCE_MS = 400;

export class ClipboardMonitor extends EventEmitter {
  private readonly debug = process.env.MARSHAL_TRANSLATOR_DEBUG === "1";
  private lastCopyTs = 0;
  private lastEmitTime = 0;
  private hookStarted = false;
  private pendingReadTimer: NodeJS.Timeout | null = null;

  private readonly onKeyDown = (event: UiohookKeyboardEvent): void => {
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
  };

  start(): void {
    uIOhook.on("keydown", this.onKeyDown);
    if (!this.hookStarted) {
      // Safe to call even if another module (PushToTalkHotkey) already started
      // the hook — uiohook is a process-wide singleton.
      uIOhook.start();
      this.hookStarted = true;
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
    // Do NOT call uIOhook.stop() — the dictation push-to-talk hotkey may still
    // depend on it. uiohook tolerates zero listeners.
    this.hookStarted = false;
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
