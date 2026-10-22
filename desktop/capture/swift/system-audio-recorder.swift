// desktop/capture/swift/system-audio-recorder.swift
//
// ScreenCaptureKit audio-only recorder for meeting capture. It records the
// system/app audio stream to an M4A file; Node mixes it with the microphone
// WAV and normalizes the result for Whisper.
//
// The file is written fragmented (#252): a plain M4A has no index until
// finishWriting, so a helper that died any other way — crash, SIGKILL, the
// app quitting — left the remote side of the call unreadable. Fragments keep
// it readable up to the last second; finishWriting still produces a normal
// file. EOF on stdin, SIGTERM and SIGINT finalize before exiting.

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

@available(macOS 13.0, *)
final class SystemAudioRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var audioInput: AVAssetWriterInput?
    private var firstPts: CMTime?
    private var outputURL: URL?
    private let streamQueue = DispatchQueue(label: "com.marshal.system-audio-recorder.stream")

    var isRecording: Bool { stream != nil }

    func start(outPath: String) async throws {
        let content = try await SCShareableContent.current
        guard let display = content.displays.first else {
            throw NSError(
                domain: "SystemAudioRecorder", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No available display"]
            )
        }

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 3

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let url = URL(fileURLWithPath: outPath)
        try? FileManager.default.removeItem(at: url)

        let assetWriter = try AVAssetWriter(url: url, fileType: .m4a)
        // Must be set before startWriting. One second bounds what a hard kill
        // can lose; the fragment headers cost a few bytes per second.
        assetWriter.movieFragmentInterval = CMTime(value: 1, timescale: 1)
        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 128_000
        ]
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        input.expectsMediaDataInRealTime = true
        assetWriter.add(input)

        self.writer = assetWriter
        self.audioInput = input
        self.outputURL = url
        self.firstPts = nil

        assetWriter.startWriting()

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: streamQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() async throws -> String {
        guard let stream else {
            throw NSError(
                domain: "SystemAudioRecorder", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Not recording"]
            )
        }

        // A stream that already died (didStopWithError) refuses to stop;
        // the samples written so far must still be finalized.
        var stopError: Error?
        do {
            try await stream.stopCapture()
        } catch {
            stopError = error
        }
        self.stream = nil

        let finishedWriter = writer
        if finishedWriter?.status == .writing {
            audioInput?.markAsFinished()
            await finishedWriter?.finishWriting()
        }

        let path = outputURL?.path ?? ""
        writer = nil
        audioInput = nil
        outputURL = nil
        firstPts = nil
        if finishedWriter?.status == .failed {
            throw finishedWriter?.error ?? stopError ?? NSError(
                domain: "SystemAudioRecorder", code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Writer failed"]
            )
        }
        if let stopError {
            FileHandle.standardError.write(Data("stopCapture failed: \(stopError.localizedDescription)\n".utf8))
        }
        return path
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid else { return }

        if firstPts == nil {
            firstPts = sampleBuffer.presentationTimeStamp
            writer?.startSession(atSourceTime: .zero)
        }
        guard let firstPts, let input = audioInput, input.isReadyForMoreMediaData else { return }

        let pts = CMTimeSubtract(sampleBuffer.presentationTimeStamp, firstPts)
        var timing = CMSampleTimingInfo(
            duration: sampleBuffer.duration,
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

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emitLine("error \(error.localizedDescription)")
    }
}

func emitLine(_ line: String) {
    guard let data = (line + "\n").data(using: .utf8) else { return }
    FileHandle.standardOutput.write(data)
}

guard #available(macOS 13.0, *) else {
    FileHandle.standardError.write(Data("requires macOS 13.0 or newer\n".utf8))
    exit(2)
}

let recorder = SystemAudioRecorder()

// Finalizes an in-progress file, then exits. Bounded: a stop that never
// returns must not keep an orphaned helper capturing audio forever.
func finalizeAndExit(_ code: Int32) {
    DispatchQueue.global().asyncAfter(deadline: .now() + 5) { exit(code) }
    Task {
        if recorder.isRecording {
            _ = try? await recorder.stop()
        }
        exit(code)
    }
}

signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { finalizeAndExit(0) }
termSource.resume()
signal(SIGINT, SIG_IGN)
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSource.setEventHandler { finalizeAndExit(0) }
intSource.resume()

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }

        let parts = trimmed.split(separator: " ", maxSplits: 8, omittingEmptySubsequences: true).map(String.init)
        guard let cmd = parts.first else { continue }

        switch cmd {
        case "start":
            guard parts.count >= 2 else {
                emitLine("error usage: start <outPath>")
                continue
            }
            let outPath = parts.dropFirst().joined(separator: " ")
            Task {
                do {
                    try await recorder.start(outPath: outPath)
                    emitLine("started")
                } catch {
                    emitLine("error \(error.localizedDescription)")
                }
            }
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
            finalizeAndExit(0)
            return
        default:
            emitLine("error unknown command: \(cmd)")
        }
    }
    // stdin closed: Marshal is gone (crash, force quit). Nobody will send
    // `stop`, so finalize the file ourselves.
    finalizeAndExit(0)
}

RunLoop.main.run()
