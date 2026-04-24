// desktop/capture/swift/screen-recorder.swift
//
// ScreenCaptureKit-based screen recorder. Driven from stdin by the Electron
// main process — line-based command protocol keeps coupling minimal (no
// Swift↔Node IPC beyond pipes).
//
// Requires macOS 12.3+. Emits events on stdout; human-readable errors on
// stderr. Exits on `quit`, on stdin close, or on a fatal capture error.
//
// Commands (stdin, one per line):
//   start-fullscreen <outPath>
//   start-area <x> <y> <w> <h> <outPath>
//   pause
//   resume
//   stop
//   quit
//
// Events (stdout, one per line):
//   started
//   paused
//   resumed
//   stopped <outPath>
//   error <message>

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import AppKit

@available(macOS 12.3, *)
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var isPaused = false
    private var firstPts: CMTime?
    private var outputURL: URL?
    private let streamQueue = DispatchQueue(label: "com.marshal.screen-recorder.stream")

    func startFullscreen(outPath: String) async throws {
        let (display, scale) = try await pickPrimaryDisplay()
        let config = SCStreamConfiguration()
        config.width = Int(Double(display.width) * scale)
        config.height = Int(Double(display.height) * scale)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.queueDepth = 6
        config.showsCursor = true
        try await startCapture(
            filter: SCContentFilter(display: display, excludingWindows: []),
            config: config,
            outPath: outPath
        )
    }

    func startArea(x: Double, y: Double, w: Double, h: Double, outPath: String) async throws {
        let (display, scale) = try await pickPrimaryDisplay()
        let config = SCStreamConfiguration()
        config.sourceRect = CGRect(x: x, y: y, width: w, height: h)
        config.width = Int(w * scale)
        config.height = Int(h * scale)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.queueDepth = 6
        config.showsCursor = true
        try await startCapture(
            filter: SCContentFilter(display: display, excludingWindows: []),
            config: config,
            outPath: outPath
        )
    }

    private func pickPrimaryDisplay() async throws -> (SCDisplay, Double) {
        // `SCShareableContent.current` triggers the Screen Recording TCC prompt
        // on first run. If the user denies, the call throws — surface that to
        // the caller verbatim so the UI can explain what to do.
        let content = try await SCShareableContent.current
        guard let display = content.displays.first else {
            throw NSError(
                domain: "Recorder", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No available display"]
            )
        }
        let scale = await MainActor.run { NSScreen.main?.backingScaleFactor ?? 2 }
        return (display, Double(scale))
    }

    private func startCapture(
        filter: SCContentFilter,
        config: SCStreamConfiguration,
        outPath: String
    ) async throws {
        let url = URL(fileURLWithPath: outPath)
        try? FileManager.default.removeItem(at: url)

        let assetWriter = try AVAssetWriter(url: url, fileType: .mov)
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: config.width,
            AVVideoHeightKey: config.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: max(2_000_000, config.width * config.height * 6)
            ]
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        input.expectsMediaDataInRealTime = true
        assetWriter.add(input)

        self.writer = assetWriter
        self.videoInput = input
        self.outputURL = url
        self.firstPts = nil
        self.isPaused = false

        assetWriter.startWriting()

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: streamQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    func pause() { isPaused = true }
    func resume() { isPaused = false }

    func stop() async throws -> String {
        guard let stream else { throw NSError(domain: "Recorder", code: 2, userInfo: [NSLocalizedDescriptionKey: "Not recording"]) }

        try await stream.stopCapture()
        self.stream = nil

        videoInput?.markAsFinished()
        await writer?.finishWriting()

        let path = outputURL?.path ?? ""
        writer = nil
        videoInput = nil
        outputURL = nil
        firstPts = nil
        return path
    }

    // MARK: SCStreamOutput

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen, sampleBuffer.isValid, !isPaused else { return }
        // ScreenCaptureKit hands us frames even when nothing has changed — drop
        // everything except `.complete` so the file stays lean.
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let statusRaw = attachments.first?[.status] as? Int,
            SCFrameStatus(rawValue: statusRaw) == .complete
        else { return }

        if firstPts == nil {
            firstPts = sampleBuffer.presentationTimeStamp
            writer?.startSession(atSourceTime: .zero)
        }
        guard let firstPts, let input = videoInput, input.isReadyForMoreMediaData else { return }

        let pts = CMTimeSubtract(sampleBuffer.presentationTimeStamp, firstPts)
        var timing = CMSampleTimingInfo(
            duration: .invalid,
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid
        )
        var retimed: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sampleBuffer,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleBufferOut: &retimed
        )
        if status == noErr, let retimed {
            input.append(retimed)
        }
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emitLine("error \(error.localizedDescription)")
    }
}

// MARK: - stdin command loop

func emitLine(_ line: String) {
    guard let data = (line + "\n").data(using: .utf8) else { return }
    FileHandle.standardOutput.write(data)
}

guard #available(macOS 12.3, *) else {
    FileHandle.standardError.write(Data("requires macOS 12.3 or newer\n".utf8))
    exit(2)
}

let recorder = Recorder()

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }

        let parts = trimmed.split(separator: " ", maxSplits: 32, omittingEmptySubsequences: true).map(String.init)
        guard let cmd = parts.first else { continue }

        switch cmd {
        case "start-fullscreen":
            guard parts.count >= 2 else {
                emitLine("error usage: start-fullscreen <outPath>")
                continue
            }
            // Out-path may contain spaces — everything after the command is the path.
            let outPath = parts.dropFirst().joined(separator: " ")
            Task {
                do {
                    try await recorder.startFullscreen(outPath: outPath)
                    emitLine("started")
                } catch {
                    emitLine("error \(error.localizedDescription)")
                }
            }
        case "start-area":
            guard parts.count >= 6,
                  let x = Double(parts[1]),
                  let y = Double(parts[2]),
                  let w = Double(parts[3]),
                  let h = Double(parts[4]) else {
                emitLine("error usage: start-area <x> <y> <w> <h> <outPath>")
                continue
            }
            let outPath = parts.dropFirst(5).joined(separator: " ")
            Task {
                do {
                    try await recorder.startArea(x: x, y: y, w: w, h: h, outPath: outPath)
                    emitLine("started")
                } catch {
                    emitLine("error \(error.localizedDescription)")
                }
            }
        case "pause":
            recorder.pause()
            emitLine("paused")
        case "resume":
            recorder.resume()
            emitLine("resumed")
        case "stop":
            Task {
                do {
                    let path = try await recorder.stop()
                    emitLine("stopped \(path)")
                } catch {
                    emitLine("error \(error.localizedDescription)")
                }
            }
        case "quit":
            exit(0)
        default:
            emitLine("error unknown command: \(cmd)")
        }
    }
    // stdin closed — treat as quit.
    exit(0)
}

RunLoop.main.run()
