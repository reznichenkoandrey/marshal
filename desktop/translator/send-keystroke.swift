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

import Cocoa
import Carbon.HIToolbox

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: send-keystroke c|v\n".utf8))
    exit(1)
}

let keyCode: CGKeyCode
switch args[1] {
case "c": keyCode = CGKeyCode(kVK_ANSI_C)
case "v": keyCode = CGKeyCode(kVK_ANSI_V)
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

down.flags = .maskCommand
up.flags = .maskCommand

down.post(tap: .cghidEventTap)
// Small gap so the receiving app registers down+up as a complete keystroke.
// 15 ms is well below the human threshold yet enough for Cocoa apps like
// Chrome and VS Code to dispatch the shortcut reliably.
Thread.sleep(forTimeInterval: 0.015)
up.post(tap: .cghidEventTap)
