// desktop/capture/swift/system-audio-recorder.swift
//
// ScreenCaptureKit audio-only recorder for meeting capture. It records the
// system/app audio stream to an M4A file; Node mixes it with the microphone
// WAV and normalizes the result for Whisper.

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

        try await stream.stopCapture()
        self.stream = nil

        audioInput?.markAsFinished()
        await writer?.finishWriting()

        let path = outputURL?.path ?? ""
        writer = nil
        audioInput = nil
        outputURL = nil
        firstPts = nil
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
            exit(0)
        default:
            emitLine("error unknown command: \(cmd)")
        }
    }
    exit(0)
}

RunLoop.main.run()
