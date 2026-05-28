// desktop/dictation/swift-ptt-monitor.ts
//
// Push-to-talk hotkey path that wraps the ptt-monitor Swift helper. Used as
// a drop-in replacement for PushToTalkHotkey (uiohook-napi) when the user's
// chosen hotkey is a modifier-only key (Right Command, Left Command, etc.).
//
// Why this exists: uiohook taps CGEventTap, which on macOS Sequoia 15.x
// silently drops keyDown / flagsChanged for self-signed Electron bundles
// even when Input Monitoring is granted. NSEvent.addGlobalMonitorForEvents
// (the Swift path) goes through AppKit's prefiltering layer and asks only
// for Accessibility — which the parent Electron process already has, and
// which child processes inherit. See desktop/dictation/ptt-monitor.swift
// for the long-form story.
//
// The class deliberately mirrors PushToTalkHotkey's public API
// (start / stop / forceEnd / EventEmitter "hold-start" / "hold-end" /
// "input-monitoring-silent") so DictationService doesn't need to know which
// backend is in use.

import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asarUnpacked } from "../utils/asar-paths.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const distDictationDir = asarUnpacked(path.dirname(currentFilePath));
const DEFAULT_MONITOR_BIN = path.join(distDictationDir, "ptt-monitor");

// Virtual keycodes for modifier keys, taken from Carbon's HIToolbox
// (kVK_Right*). Indexed by the same lowercased token PushToTalkHotkey's
// parseHotkey() understands.
const KEYCODE_BY_TOKEN: Record<string, number> = {
  rightcmd: 54, // kVK_RightCommand
  rcmd: 54,
  rightcommand: 54,
  cmdright: 54,
  commandright: 54,
  leftcmd: 55, // kVK_Command
  lcmd: 55,
  leftcommand: 55,
  cmdleft: 55,
  commandleft: 55,
  rightshift: 60, // kVK_RightShift
  rshift: 60,
  leftshift: 56, // kVK_Shift
  lshift: 56,
  rightoption: 61, // kVK_RightOption
  roption: 61,
  rightalt: 61,
  ralt: 61,
  leftoption: 58, // kVK_Option
  loption: 58,
  leftalt: 58,
  lalt: 58,
  rightcontrol: 62, // kVK_RightControl
  rctrl: 62,
  leftcontrol: 59, // kVK_Control
  lctrl: 59
};

/**
 * Decide whether a hotkey string can be served by the Swift monitor. The
 * Swift path is targeted at modifier-only push-to-talk (Right Cmd / Right
 * Shift / ...). Multi-key chords (Cmd+Alt+M) and letter targets stay on
 * uiohook for now.
 */
export function isSwiftPttCandidate(hotkey: string): boolean {
  const trimmed = hotkey.trim().toLowerCase();
  return trimmed in KEYCODE_BY_TOKEN;
}

function resolveKeycode(hotkey: string): number {
  const trimmed = hotkey.trim().toLowerCase();
  const code = KEYCODE_BY_TOKEN[trimmed];
  if (!code) throw new Error(`Swift PTT monitor does not handle hotkey "${hotkey}"`);
  return code;
}

export type SwiftPttEvents = {
  "hold-start": [];
  "hold-end": [];
  // Mirrors PushToTalkHotkey: emitted when the OS isn't delivering modifier
  // events to us. For the Swift path this means Accessibility was revoked
  // for the helper — same user remediation either way.
  "input-monitoring-silent": [];
};

const READY_TIMEOUT_MS = 1_500;

export class SwiftPushToTalkHotkey extends EventEmitter {
  private readonly hotkey: string;
  private readonly keycode: number;
  private readonly binPath: string;
  private readonly debug: boolean;
  private child: ChildProcess | null = null;
  private holding = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(hotkey: string) {
    super();
    this.hotkey = hotkey;
    this.keycode = resolveKeycode(hotkey);
    this.binPath = process.env.MARSHAL_DICTATION_PTT_BIN ?? DEFAULT_MONITOR_BIN;
    this.debug = process.env.MARSHAL_DICTATION_DEBUG === "1";
  }

  start(): void {
    if (this.child) return;
    if (this.debug) {
      console.log(`[hotkey:swift] spawning ${this.binPath} for ${this.hotkey} (keycode=${this.keycode})`);
    }
    let child: ChildProcess;
    try {
      child = spawn(this.binPath, ["--keycode", String(this.keycode)], {
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      // Binary missing or unexecutable. Treat as "silent" so the main
      // process surfaces the same actionable notification it does for
      // uiohook failures — at worst the user falls back to Cmd+Alt+M.
      console.warn(
        "[hotkey:swift] failed to spawn ptt-monitor:",
        err instanceof Error ? err.message : err
      );
      this.emit("input-monitoring-silent");
      return;
    }
    this.child = child;

    // Watchdog: if the helper never prints `ready` within READY_TIMEOUT_MS
    // it's almost certainly because Accessibility was revoked (helper exits
    // with code 3 + "not-trusted" on stdout). Surface the silence signal
    // immediately so the user sees a notification instead of a hung mic.
    this.readyTimer = setTimeout(() => {
      if (this.debug) {
        console.warn("[hotkey:swift] ptt-monitor did not signal ready in time");
      }
      this.emit("input-monitoring-silent");
    }, READY_TIMEOUT_MS);

    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newlineIdx: number;
      // Process line-by-line. The helper line-buffers stdout (setbuf nil)
      // so each token arrives on its own newline.
      while ((newlineIdx = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newlineIdx).trim();
        buffered = buffered.slice(newlineIdx + 1);
        this.handleLine(line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) console.warn("[hotkey:swift] stderr:", text);
    });

    child.on("error", (err) => {
      this.clearReadyTimer();
      console.warn("[hotkey:swift] child error:", err);
      this.child = null;
      this.emit("input-monitoring-silent");
    });

    child.on("exit", (code) => {
      this.clearReadyTimer();
      if (this.debug) {
        console.log(`[hotkey:swift] ptt-monitor exited code=${code}`);
      }
      this.child = null;
      // If we were holding when the process died, synthesize hold-end so
      // the dictation service can shut the recorder down cleanly.
      if (this.holding) {
        this.holding = false;
        this.emit("hold-end");
      }
      // Non-zero exit before any "ready" — probably Accessibility denied
      // (the Swift helper exits 3 in that case). Tell the user.
      if (code === 3) this.emit("input-monitoring-silent");
    });
  }

  private handleLine(line: string): void {
    if (line.length === 0) return;
    if (line === "ready") {
      this.clearReadyTimer();
      if (this.debug) console.log("[hotkey:swift] ptt-monitor ready");
      return;
    }
    if (line === "not-trusted") {
      this.clearReadyTimer();
      this.emit("input-monitoring-silent");
      return;
    }
    if (line === "down") {
      if (this.holding) return;
      this.holding = true;
      this.emit("hold-start");
      return;
    }
    if (line === "up") {
      if (!this.holding) return;
      this.holding = false;
      this.emit("hold-end");
      return;
    }
    if (this.debug) console.log("[hotkey:swift] unknown line:", line);
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  /**
   * Mirrors PushToTalkHotkey.forceEnd — used by the dictation safety-net
   * timer when the up event never arrives.
   */
  forceEnd(): void {
    if (!this.holding) return;
    this.holding = false;
    this.emit("hold-end");
  }

  stop(): void {
    this.clearReadyTimer();
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch (err) {
        if (this.debug) console.warn("[hotkey:swift] kill error:", err);
      }
      this.child = null;
    }
    this.holding = false;
  }
}
