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

// Translate the modifier flag bit corresponding to our target keycode.
// AppKit collapses left/right modifier pairs into the same flag (`.command`,
// `.shift`, `.option`, `.control`) so we infer "pressed" from the flag and
// the keyCode of the flagsChanged event together — that tells us which
// physical key actually moved.
func isOurKeyPressed(_ ev: NSEvent) -> Bool {
    guard ev.keyCode == targetKeyCode else { return holding } // not ours; keep state
    switch targetKeyCode {
    case UInt16(kVK_RightCommand), UInt16(kVK_Command):
        return ev.modifierFlags.contains(.command)
    case UInt16(kVK_RightShift), UInt16(kVK_Shift):
        return ev.modifierFlags.contains(.shift)
    case UInt16(kVK_RightOption), UInt16(kVK_Option):
        return ev.modifierFlags.contains(.option)
    case UInt16(kVK_RightControl), UInt16(kVK_Control):
        return ev.modifierFlags.contains(.control)
    default:
        // Function keys and oddballs — we still emit on the event itself.
        return !holding
    }
}

let handler: (NSEvent) -> Void = { ev in
    // Filter early — flagsChanged fires for every modifier transition; we
    // only care about transitions of OUR target keycode.
    guard ev.keyCode == targetKeyCode else { return }
    let down = isOurKeyPressed(ev)
    if down && !holding {
        holding = true
        FileHandle.standardOutput.write(Data("down\n".utf8))
    } else if !down && holding {
        holding = false
        FileHandle.standardOutput.write(Data("up\n".utf8))
    }
}

// Global monitor fires for events delivered to OTHER apps. Local monitor
// fires when our own process is frontmost. Push-to-talk needs both —
// without the local pair, holding Right-Cmd while Marshal's popover has
// focus would do nothing.
let globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: handler)
let localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { ev in
    handler(ev)
    return ev
}

// SIGTERM clean exit — parent kills us on app quit. Both monitors are
// idempotent to nil release; the OS reclaims them anyway, but explicit
// removal keeps Console.app quiet.
func shutdown() -> Never {
    if let monitor = globalMonitor { NSEvent.removeMonitor(monitor) }
    NSEvent.removeMonitor(localMonitor)
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

// Handshake — node side waits for this line before treating the monitor
// as armed (mirrors audio-recorder's "ready" protocol).
FileHandle.standardOutput.write(Data("ready\n".utf8))

// Drive AppKit's run loop so addGlobalMonitorForEvents actually fires.
NSApplication.shared.run()
