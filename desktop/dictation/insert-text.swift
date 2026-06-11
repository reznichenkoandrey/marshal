// desktop/dictation/insert-text.swift
//
// Type dictated text directly into the focused field of the frontmost app via
// synthetic CGEvent keyboard events carrying a unicode payload. This is the
// primary delivery path for dictation (#102): the transcript appears at the
// caret, the instant transcription finishes, without touching the clipboard.
//
// Why CGEvent unicode (and NOT the Accessibility API):
//   The earlier AX approach (AXUIElementSetAttributeValue with kAXSelectedText)
//   was proven dead in this environment — AXUIElementCopyAttributeValue for the
//   system-wide focused element returns -25204 (kAXErrorCannotComplete) even on
//   native AppKit fields (Notes, TextEdit). Reason: each self-signed Swift
//   helper gets its OWN TCC Accessibility bucket, which the user hasn't granted,
//   so AX tree access is denied no matter what AXIsProcessTrusted() claims.
//   CGEventPost(.cghidEventTap), by contrast, works under the parent Marshal
//   app's grant via process inheritance — this is the exact mechanism
//   send-keystroke.swift relies on for its (working) synthetic Cmd+V. So we
//   deliver text the same way: as HID-level keystrokes, which land in whatever
//   field currently has keyboard focus.
//
// The text is read from STDIN, not argv — transcripts contain arbitrary unicode,
// quotes and newlines that must never be reinterpreted by a shell.
//
// Exit codes:
//   0  posted the keystrokes
//   2  could not create the CGEventSource / events (CGEvent infra failure)
//
// Note: posting keystrokes always "succeeds" even if no field has focus (the
// events simply go nowhere). The Node caller therefore ALSO writes the
// transcript to the clipboard as a backup before invoking us, so text is never
// lost when there is no focused field.

import Cocoa
import Carbon.HIToolbox

// Read the full transcript from stdin (utf8). Empty input is a no-op success.
let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard let text = String(data: inputData, encoding: .utf8), !text.isEmpty else {
    exit(0)
}

guard let source = CGEventSource(stateID: .hidSystemState) else {
    FileHandle.standardError.write(Data("failed to create CGEventSource\n".utf8))
    exit(2)
}

// CGEvent.keyboardSetUnicodeString takes a UTF-16 buffer. Post in modest
// chunks: a single event can carry a whole string, but chunking keeps each
// synthetic keystroke small, sidesteps any internal length limits, and lets
// long transcripts land reliably across receiving apps. virtualKey is 0 — the
// keycode is irrelevant once a unicode string is attached; the receiver reads
// the unicode payload, not the physical key.
let utf16 = Array(text.utf16)
let chunkSize = 16
var index = 0
while index < utf16.count {
    let end = min(index + chunkSize, utf16.count)
    var chunk = Array(utf16[index..<end])

    guard
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
    else {
        FileHandle.standardError.write(Data("failed to create CGEvent\n".utf8))
        exit(2)
    }

    // Clear any inherited modifier flags (e.g. a still-physically-held Right
    // Command from push-to-talk) so the unicode payload isn't interpreted as a
    // shortcut by the receiving app.
    keyDown.flags = []
    keyUp.flags = []

    keyDown.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
    keyDown.post(tap: .cghidEventTap)
    keyUp.post(tap: .cghidEventTap)

    index = end
    // Tiny gap so fast receivers (Chromium, AppKit) register each chunk as a
    // discrete input event rather than coalescing/dropping.
    if index < utf16.count {
        Thread.sleep(forTimeInterval: 0.003)
    }
}

exit(0)
