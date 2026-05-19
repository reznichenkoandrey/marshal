// desktop/capture/swift/scroll-capture.swift
//
// Generic scrolling capture helper. Snaps the requested rectangle, sends a
// scroll-wheel event to whatever window owns that area, waits for the page
// to settle, snaps again, and repeats until either:
//   - the next frame is byte-identical to the previous (page bottom)
//   - the requested max number of scrolls is reached
//
// Frames are written as `frame-NNNN.png` into the output directory. Stitching
// is delegated to scroll-stitch.swift — separating the two means we can
// debug capture artefacts independently from the Vision-framework alignment
// pass.
//
// Args (positional, all required):
//   x y w h   — capture rectangle in CSS pixels (Cocoa flipped Y)
//   outDir    — directory to receive frame-NNNN.png
//   scrolls   — hard cap on iterations
//   delayMs   — wait after each scroll before snapping the next frame
//
// Stdout: `frame <path>` per saved frame, `done <count>` on success,
//         `settled <index>` when the loop short-circuits on a duplicate.
// Stderr: human-readable error messages.

import Foundation
import CoreGraphics
import AppKit
import ScreenCaptureKit

// MARK: - Arg parsing -----------------------------------------------------

guard CommandLine.arguments.count == 8 else {
    FileHandle.standardError.write("usage: scroll-capture x y w h outDir scrolls delayMs\n".data(using: .utf8)!)
    exit(2)
}

let argv = CommandLine.arguments
guard
    let x = Double(argv[1]),
    let y = Double(argv[2]),
    let w = Double(argv[3]),
    let h = Double(argv[4]),
    let maxScrolls = Int(argv[6]),
    let delayMs = Int(argv[7])
else {
    FileHandle.standardError.write("invalid numeric argument\n".data(using: .utf8)!)
    exit(2)
}
let outDir = argv[5]
let scrollAmount: Int32 = -8   // lines per wheel tick — negative = scroll down

// MARK: - Output dir ------------------------------------------------------

do {
    try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
} catch {
    FileHandle.standardError.write("cannot create outDir: \(error)\n".data(using: .utf8)!)
    exit(3)
}

// MARK: - Helpers ---------------------------------------------------------

func emit(_ s: String) {
    FileHandle.standardOutput.write("\(s)\n".data(using: .utf8)!)
}

func sleepMs(_ ms: Int) {
    Thread.sleep(forTimeInterval: Double(ms) / 1000.0)
}

func postScrollDown() {
    // CGEvent vertical wheel — post at HID level so the OS routes the event
    // to whichever window currently sits under the cursor.
    if let ev = CGEvent(scrollWheelEvent2Source: nil,
                       units: .line,
                       wheelCount: 1,
                       wheel1: scrollAmount,
                       wheel2: 0,
                       wheel3: 0) {
        ev.post(tap: .cghidEventTap)
    }
}

// Cheap byte-stream fingerprint — sum of every 1024th byte. Good enough to
// detect "page didn't scroll" since two identical PNG encodes yield matching
// streams. Avoids pulling in CommonCrypto for what is effectively a hash.
func fingerprint(_ data: Data) -> String {
    var sum: UInt64 = 0
    data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
        let count = buf.count
        var i = 0
        while i < count {
            sum = sum &+ UInt64(buf[i])
            i += 1024
        }
    }
    return String(sum)
}

// MARK: - ScreenCaptureKit one-shot capture ------------------------------

// Resolve the primary display via SCShareableContent. Cache the filter so we
// only trigger the TCC prompt once.
let captureRect = CGRect(x: x, y: y, width: w, height: h)

actor Recorder {
    private var filter: SCContentFilter?
    private var configBase: SCStreamConfiguration?
    private var scale: Double = 2.0

    func prepare() async throws {
        let content = try await SCShareableContent.current
        guard let display = content.displays.first else {
            throw NSError(domain: "ScrollCapture", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No available display"])
        }
        scale = await MainActor.run { NSScreen.main?.backingScaleFactor ?? 2 }
        filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        // SourceRect crops on the display side so we don't have to resample.
        config.sourceRect = captureRect
        config.width = Int(captureRect.width * scale)
        config.height = Int(captureRect.height * scale)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        configBase = config
    }

    func snap() async throws -> Data {
        guard let filter, let configBase else {
            throw NSError(domain: "ScrollCapture", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Recorder not prepared"])
        }
        let cgImage = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configBase
        )
        let rep = NSBitmapImageRep(cgImage: cgImage)
        guard let pngData = rep.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "ScrollCapture", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "PNG encode failed"])
        }
        return pngData
    }
}

// MARK: - Main async pump -------------------------------------------------

let group = DispatchGroup()
group.enter()

Task {
    defer { group.leave() }

    let recorder = Recorder()
    do {
        try await recorder.prepare()
    } catch {
        FileHandle.standardError.write("prepare failed: \(error)\n".data(using: .utf8)!)
        exit(4)
    }

    // Centre the cursor over the capture rect so scroll events route to the
    // intended window. The cursor is captured-then-moved before we ever take
    // a frame, so the first PNG doesn't show the warp.
    let centre = CGPoint(x: captureRect.midX, y: captureRect.midY)
    CGWarpMouseCursorPosition(centre)
    sleepMs(120)

    var lastFingerprint: String? = nil
    var saved = 0

    for i in 0..<maxScrolls {
        let pngData: Data
        do {
            pngData = try await recorder.snap()
        } catch {
            FileHandle.standardError.write("snap failed at \(i): \(error)\n".data(using: .utf8)!)
            exit(5)
        }
        let filename = String(format: "frame-%04d.png", i)
        let fullPath = (outDir as NSString).appendingPathComponent(filename)
        do {
            try pngData.write(to: URL(fileURLWithPath: fullPath))
        } catch {
            FileHandle.standardError.write("write failed at \(i): \(error)\n".data(using: .utf8)!)
            exit(6)
        }
        emit("frame \(fullPath)")
        saved += 1

        let print = fingerprint(pngData)
        if let prev = lastFingerprint, prev == print {
            emit("settled \(i)")
            break
        }
        lastFingerprint = print

        postScrollDown()
        sleepMs(delayMs)
    }

    emit("done \(saved)")
}

group.wait()
