// pasteboard-watcher.swift
// Monitors NSPasteboard.changeCount and prints a millisecond timestamp to stdout
// every time the clipboard is written (even if the content is identical).
// Requires NO macOS permissions — only reads the changeCount integer.
// Compiled by postbuild.mjs → dist/desktop/translator/pasteboard-watcher

import AppKit
import Foundation

var lastCount = NSPasteboard.general.changeCount

// Notify the parent process that the watcher is ready
var readyData = "ready\n".data(using: .utf8)!
FileHandle.standardOutput.write(readyData)

while true {
  Thread.sleep(forTimeInterval: 0.05) // 50 ms poll — ~2 % CPU headroom
  let count = NSPasteboard.general.changeCount
  guard count != lastCount else { continue }
  lastCount = count
  let ms = Int64(Date().timeIntervalSince1970 * 1000)
  let line = "\(ms)\n".data(using: .utf8)!
  FileHandle.standardOutput.write(line)
}
