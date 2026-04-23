// desktop/translator/clipboard-monitor.ts
// Detects double Cmd+C (same or different text) via NSPasteboard.changeCount.
//
// Strategy:
//   1. Spawn a pre-compiled Swift helper (pasteboard-watcher) that outputs a
//      Unix-ms timestamp each time NSPasteboard.changeCount changes — even when
//      the clipboard content is identical to the previous copy.
//      This requires NO macOS permissions whatsoever.
//   2. If the binary is unavailable, fall back to clipboard-text polling which
//      can only detect double-copy of DIFFERENT texts.
//
// Dedicated hotkey ⌘⇧T always works regardless of clipboard content.

import { clipboard, globalShortcut } from "electron";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const DOUBLE_COPY_WINDOW_MS = 600;
const DEDICATED_HOTKEY = "CommandOrControl+Shift+T";
// Prevents double-emit when both watcher and polling fire for the same event
const EMIT_DEBOUNCE_MS = 400;

const currentFilePath = fileURLToPath(import.meta.url);
const distTranslatorDir = path.dirname(currentFilePath);
// pasteboard-watcher binary is compiled next to this file in dist/desktop/translator/
const WATCHER_BIN = path.join(distTranslatorDir, "pasteboard-watcher");

export class ClipboardMonitor extends EventEmitter {
  private watcherProcess: ReturnType<typeof spawn> | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private lastChangeTimestamp = 0;
  private lastEmitTime = 0;

  start(): void {
    if (process.platform === "darwin" && fs.existsSync(WATCHER_BIN)) {
      this.startPasteboardWatcher();
    } else {
      console.log("[ClipboardMonitor] pasteboard-watcher not found, using polling fallback");
      this.startPollingFallback();
    }

    globalShortcut.register(DEDICATED_HOTKEY, () => {
      const text = clipboard.readText().trim();
      if (text) this.emit("translate", text);
    });
  }

  stop(): void {
    if (this.watcherProcess) {
      this.watcherProcess.kill();
      this.watcherProcess = null;
    }
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    globalShortcut.unregister(DEDICATED_HOTKEY);
  }

  /** Emit with debounce to avoid duplicate triggers. */
  private safeEmit(text: string): void {
    const now = Date.now();
    if (now - this.lastEmitTime < EMIT_DEBOUNCE_MS) return;
    this.lastEmitTime = now;
    this.lastChangeTimestamp = 0;
    console.log("[ClipboardMonitor] → translate:", text.slice(0, 40));
    this.emit("translate", text);
  }

  /**
   * Spawns the Swift pasteboard-watcher binary.
   * The binary writes a Unix-ms timestamp to stdout each time NSPasteboard
   * changeCount increments — including when the same text is copied again.
   * Zero permissions required.
   */
  private startPasteboardWatcher(): void {
    console.log("[ClipboardMonitor] starting pasteboard-watcher:", WATCHER_BIN);

    this.watcherProcess = spawn(WATCHER_BIN, [], { stdio: ["ignore", "pipe", "pipe"] });

    let buffer = "";

    this.watcherProcess.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "ready") continue;

        const ts = parseInt(trimmed, 10);
        if (isNaN(ts)) continue;

        const elapsed = ts - this.lastChangeTimestamp;
        console.log(`[ClipboardMonitor] pasteboard changed, elapsed=${elapsed}ms`);

        if (this.lastChangeTimestamp > 0 && elapsed <= DOUBLE_COPY_WINDOW_MS) {
          const text = clipboard.readText().trim();
          if (text) this.safeEmit(text);
        } else {
          this.lastChangeTimestamp = ts;
        }
      }
    });

    this.watcherProcess.stderr!.on("data", (d: Buffer) => {
      console.warn("[ClipboardMonitor] watcher stderr:", d.toString().trim());
    });

    this.watcherProcess.on("exit", (code) => {
      console.warn("[ClipboardMonitor] pasteboard-watcher exited (code:", code, ") — switching to polling");
      this.watcherProcess = null;
      if (this.pollingTimer === null) {
        this.startPollingFallback();
      }
    });
  }

  /**
   * Polls clipboard text every 150 ms.
   * Can only detect double-copy when the clipboard TEXT changes.
   * Used when the Swift watcher is unavailable (non-macOS or first build).
   *
   * Seeds timing state from `this.lastChangeTimestamp` so that when the Swift
   * watcher dies mid-session the very next double-copy is still detected —
   * previously a fresh local `lastChangeTime = 0` silently dropped the first
   * double-copy after the switch.
   */
  private startPollingFallback(): void {
    let lastText = clipboard.readText();
    const POLL_MS = 150;

    this.pollingTimer = setInterval(() => {
      const current = clipboard.readText();
      if (!current.trim() || current === lastText) return;

      const now = Date.now();
      const elapsed = now - this.lastChangeTimestamp;

      if (this.lastChangeTimestamp > 0 && elapsed <= DOUBLE_COPY_WINDOW_MS) {
        this.safeEmit(current);
      }

      lastText = current;
      this.lastChangeTimestamp = now;
    }, POLL_MS);

    console.log("[ClipboardMonitor] polling fallback active");
  }
}
