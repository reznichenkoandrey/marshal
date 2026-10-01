// desktop/dictation/ptt-monitor.swift
//
// Push-to-talk hotkey monitor for modifier-only keys (Right Command by
// default). Wraps NSEvent.addGlobalMonitorForEvents — which needs only
// Accessibility, NOT Input Monitoring — and emits "down\n" / "up\n" lines
// on stdout when the target modifier transitions.
//
// Why this exists (the long story):
//   uiohook-napi taps CGEventTap directly, which on macOS Sequoia 15.x
//   silently drops keyDown / flagsChanged events on self-signed Electron
//   bundles even when Input Monitoring is granted (TCC stores the original
//   CDHash; every rebuild produces a new one, the kernel-side filter then
//   blocks key events for the "new" identity while still passing mouse
//   events on the same tap). Toggle off→on in System Settings doesn't fix
//   it; only `sudo tccutil reset ListenEvent com.marshal.desktop` + Mac
//   reboot does. That's an unacceptable user experience, so we side-step
//   the issue entirely by switching to NSEvent's global monitor, which
//   funnels through AppKit's prefiltering layer and asks only for
//   Accessibility (we already have that for uiohook + send-keystroke).
//
//   See send-keystroke.swift header: "Child processes inherit the parent's
//   TCC trust for Accessibility" — so once Marshal.app is trusted, this
//   helper inherits the grant without a separate prompt.
//
// Usage:
//   ptt-monitor                  — defaults to Right Command (kVK = 54)
//   ptt-monitor --keycode N      — observe a specific virtual keycode in
//                                  flagsChanged stream
//
// Output protocol (line-buffered):
//   ready                — handshake; stdout flushed
//   down                 — modifier engaged (matches our key)
//   up                   — modifier released
//   cancel               — another modifier or key joined the hold, so it is
//                          a shortcut (⌘⌥⇧M), not push-to-talk; no `up`
//                          follows for this press (#239)
//   not-trusted          — Accessibility was revoked at startup; helper
//                          exits with code 3 immediately after

import Cocoa
import Carbon.HIToolbox

// ── argv ──
var targetKeyCode: UInt16 = UInt16(kVK_RightCommand) // 0x36 = 54
var i = 1
let args = CommandLine.arguments
while i < args.count {
    let arg = args[i]
    if arg == "--keycode" && i + 1 < args.count {
        if let parsed = UInt16(args[i + 1]) {
            targetKeyCode = parsed
        }
        i += 2
        continue
    }
    FileHandle.standardError.write(Data("ignoring unknown arg: \(arg)\n".utf8))
    i += 1
}

// ── Accessibility check ──
// Without it both global and local monitors silently no-op for key events.
// Exit with a distinctive code so the Node parent can surface a targeted
// error message and fall back to globalShortcut toggle.
if !AXIsProcessTrusted() {
    FileHandle.standardError.write(Data("Accessibility not granted for this binary; cannot observe modifier keys\n".utf8))
    FileHandle.standardOutput.write(Data("not-trusted\n".utf8))
    exit(3)
}

setbuf(stdout, nil)

var holding = false
// Set when the current press of our key turned out to be part of a chord.
// Cleared only when our key is released, so the rest of that press is ignored.
var chorded = false

// Device-dependent modifier bits (NX_DEVICE*KEYMASK) by keycode. AppKit's
// `.command` etc. collapse left and right, which would hide a left ⌘ joining
// a right-⌘ hold; these bits tell the physical keys apart.
let deviceModifierMasks: [UInt16: UInt] = [
    UInt16(kVK_Control): 0x0001, UInt16(kVK_RightControl): 0x2000,
    UInt16(kVK_Shift): 0x0002, UInt16(kVK_RightShift): 0x0004,
    UInt16(kVK_Command): 0x0008, UInt16(kVK_RightCommand): 0x0010,
    UInt16(kVK_Option): 0x0020, UInt16(kVK_RightOption): 0x0040,
    UInt16(kVK_Function): NSEvent.ModifierFlags.function.rawValue
]

func otherModifierHeld(_ ev: NSEvent) -> Bool {
    let raw = ev.modifierFlags.rawValue
    return deviceModifierMasks.contains { keyCode, mask in keyCode != targetKeyCode && raw & mask != 0 }
}

func cancelHold() {
    holding = false
    chorded = true
    FileHandle.standardOutput.write(Data("cancel\n".utf8))
}

// Whether our key is physically down after this flagsChanged event. The
// device bit names the exact key, so a left ⌘ still held does not keep a
// right-⌘ target "pressed" after it is released.
func isOurKeyPressed(_ ev: NSEvent) -> Bool {
    if let mask = deviceModifierMasks[targetKeyCode] {
        return ev.modifierFlags.rawValue & mask != 0
    }
    // Keys without a device bit (Caps Lock and oddballs): each event flips.
    return !(holding || chorded)
}

let flagsHandler: (NSEvent) -> Void = { ev in
    // Diagnostic — log EVERY flagsChanged event so we can tell whether the
    // monitor is wired up at all. Filtered out in production via the
    // PTT_MONITOR_QUIET env var.
    if ProcessInfo.processInfo.environment["PTT_MONITOR_QUIET"] != "1" {
        FileHandle.standardError.write(Data("flagsChanged keyCode=\(ev.keyCode) flags=\(ev.modifierFlags.rawValue)\n".utf8))
    }
    guard ev.keyCode == targetKeyCode else {
        if holding && otherModifierHeld(ev) { cancelHold() }
        return
    }
    let down = isOurKeyPressed(ev)
    if down && !holding && !chorded {
        // Another modifier already held: the user is typing a shortcut.
        if otherModifierHeld(ev) {
            chorded = true
            return
        }
        holding = true
        FileHandle.standardOutput.write(Data("down\n".utf8))
    } else if !down {
        chorded = false
        if holding {
            holding = false
            FileHandle.standardOutput.write(Data("up\n".utf8))
        }
    }
}

let keyDownHandler: (NSEvent) -> Void = { _ in
    if holding { cancelHold() }
}

// Global monitor fires for events delivered to OTHER apps — and that is all
// we need. ptt-monitor is a SEPARATE process from Marshal, so even when
// Marshal's own popover holds focus the RightCmd flagsChanged is delivered
// to Marshal's process, which is "another app" from our point of view, so
// the global monitor sees it. A local monitor would only fire while THIS
// helper is frontmost — which never happens under .prohibited — so we don't
// install one. (It used to be here, but it was dead code and dragging in
// AppKit's local-event path is what let the helper grab key focus, #101.)
let globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: flagsHandler)
let keyDownMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: keyDownHandler)

// SIGTERM clean exit — parent kills us on app quit. removeMonitor is
// idempotent to nil; the OS reclaims it anyway, but explicit removal keeps
// Console.app quiet.
func shutdown() -> Never {
    if let monitor = globalMonitor { NSEvent.removeMonitor(monitor) }
    if let monitor = keyDownMonitor { NSEvent.removeMonitor(monitor) }
    exit(0)
}

signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { shutdown() }
termSource.resume()

signal(SIGINT, SIG_IGN)
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSource.setEventHandler { shutdown() }
intSource.resume()

// Minimal NSApplicationDelegate. NSApp.run() returns immediately on
// Sequoia without a real delegate (it short-circuits when there's no
// applicationDidFinishLaunching handler), and that's what was killing the
// process every time. We empirically confirmed RunLoop.main.run() doesn't
// drive AppKit's event tap either — addGlobalMonitorForEvents needs the
// full NSApplication lifecycle, not just the bare CFRunLoop. So: real
// delegate + NSApp.run().
//
// Activation policy is .prohibited, NOT .accessory. Under .accessory the
// helper can become the active / key app the moment AppKit routes the
// RightCmd transition through it, yanking keyboard focus out of whatever
// text field the user is typing in — the "focus disappears as soon as I
// hold Command" bug (#101). .prohibited forbids the process from ever
// activating or taking key focus, while addGlobalMonitorForEvents keeps
// working (global monitors observe other apps' events independent of
// activation policy). No Dock icon, no focus theft, monitor still wires up.
final class Delegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // No-op. We rely on the framework lifecycle running normally so
        // the event tap that NSEvent.addGlobalMonitorForEvents schedules
        // its callbacks on is actually hooked up.
    }
}

let delegate = Delegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.prohibited)

// Handshake — node side waits for this line before treating the monitor
// as armed (mirrors audio-recorder's "ready" protocol).
FileHandle.standardOutput.write(Data("ready\n".utf8))

// Real AppKit run loop. With a delegate set + .prohibited policy this
// blocks until SIGTERM, hooks the event tap, and stays headless.
NSApplication.shared.run()
