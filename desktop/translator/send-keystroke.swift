// desktop/translator/send-keystroke.swift
//
// Synthesise a ⌘+<letter> keystroke via CGEventPost. Used by the layout
// switcher to send Cmd+C / Cmd+V without bouncing through AppleScript /
// "System Events" — that route requires a separate TCC Automation grant
// that is re-prompted every time Electron.app is re-signed (which our dev
// `patch-electron-info-plist.sh` does on every build).
//
// CGEventPost only needs Accessibility, which the parent Electron process
// already has for uiohook-napi. Child processes inherit the parent's TCC
// trust for Accessibility.
//
// Usage:
//   send-keystroke c   — sends ⌘C
//   send-keystroke v   — sends ⌘V
//   send-keystroke d   — sends ⌘D (toggles the Claude app's dictation, #450)
//   send-keystroke return | escape — the bare key, no modifiers
//   send-keystroke play | next | previous — the media keys (F8, F9, F7): macOS
//     routes them to the app that owns Now Playing, e.g. YouTube in Chrome.

import Cocoa
import Carbon.HIToolbox
import IOKit.hidsystem

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: send-keystroke c|v|d|return|escape|play|next|previous\n".utf8))
    exit(1)
}

// Media keys are not key codes: they are NSSystemDefined events (subtype 8)
// carrying the NX key type and the down (0xA) / up (0xB) state in data1.
let mediaKeys: [String: Int32] = ["play": NX_KEYTYPE_PLAY, "next": NX_KEYTYPE_NEXT, "previous": NX_KEYTYPE_PREVIOUS]
if let mediaKey = mediaKeys[args[1]] {
    for state in [0xA, 0xB] {
        guard let event = NSEvent.otherEvent(
            with: .systemDefined,
            location: .zero,
            modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(state << 8)),
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            subtype: 8,
            data1: Int((mediaKey << 16) | Int32(state << 8)),
            data2: -1
        ), let cgEvent = event.cgEvent else {
            FileHandle.standardError.write(Data("failed to create media key event\n".utf8))
            exit(2)
        }
        cgEvent.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.015)
    }
    exit(0)
}

let keyCode: CGKeyCode
var flags: CGEventFlags = .maskCommand
switch args[1] {
case "c": keyCode = CGKeyCode(kVK_ANSI_C)
case "v": keyCode = CGKeyCode(kVK_ANSI_V)
case "d": keyCode = CGKeyCode(kVK_ANSI_D)
case "return": keyCode = CGKeyCode(kVK_Return); flags = []
case "escape": keyCode = CGKeyCode(kVK_Escape); flags = []
default:
    FileHandle.standardError.write(Data("unsupported key: \(args[1])\n".utf8))
    exit(1)
}

guard let source = CGEventSource(stateID: .hidSystemState) else {
    FileHandle.standardError.write(Data("failed to create CGEventSource\n".utf8))
    exit(2)
}

guard
    let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
    let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
else {
    FileHandle.standardError.write(Data("failed to create CGEvent\n".utf8))
    exit(2)
}

down.flags = flags
up.flags = flags

down.post(tap: .cghidEventTap)
// Small gap so the receiving app registers down+up as a complete keystroke.
// 15 ms is well below the human threshold yet enough for Cocoa apps like
// Chrome and VS Code to dispatch the shortcut reliably.
Thread.sleep(forTimeInterval: 0.015)
up.post(tap: .cghidEventTap)
