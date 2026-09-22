// desktop/captions/swift/system-audio-tap.swift
//
// Live system-audio tap for the captions overlay. ScreenCaptureKit delivers
// whatever the machine is playing (the other side of a call, a webinar), with
// Marshal's own process excluded; this helper converts every buffer to
// 16 kHz mono 16-bit PCM and writes the raw samples to stdout so Node can
// segment and transcribe them as they arrive.
//
// Why not the meeting recorder: that one writes a single M4A until told to
// stop, which is right for an archive and wrong for subtitles — the audio
// must be readable while it is still being captured.
//
// Protocol:
//   stdout — raw little-endian Int16 PCM, 16 kHz, mono, no framing
//   stderr — one status line per event: `ready`, `error <message>`
//   SIGTERM / SIGINT — stops the stream and exits 0
//
// Needs Screen Recording permission (audio capture rides on SCStream), which
// the parent Electron bundle already requests for screen capture.

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

func status(_ line: String) {
    guard let data = (line + "\n").data(using: .utf8) else { return }
    FileHandle.standardError.write(data)
}

@available(macOS 13.0, *)
final class SystemAudioTap: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
    )!
    private let streamQueue = DispatchQueue(label: "com.marshal.system-audio-tap.stream")

    func start() async throws {
        let content = try await SCShareableContent.current
        guard let display = content.displays.first else {
            throw NSError(
                domain: "SystemAudioTap", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No available display"]
            )
        }

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        // Video is mandatory on an SCStream; keep it as small and slow as the
        // API allows so it costs nothing.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 3

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: streamQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() async {
        guard let stream else { return }
        try? await stream.stopCapture()
        self.stream = nil
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let formatDescription = sampleBuffer.formatDescription,
              var streamDescription = formatDescription.audioStreamBasicDescription,
              let incoming = AVAudioFormat(streamDescription: &streamDescription)
        else { return }

        if converter == nil || inputFormat != incoming {
            converter = AVAudioConverter(from: incoming, to: outputFormat)
            inputFormat = incoming
        }
        guard let converter else { return }

        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frameCount > 0,
              let inputBuffer = AVAudioPCMBuffer(pcmFormat: incoming, frameCapacity: AVAudioFrameCount(frameCount))
        else { return }
        inputBuffer.frameLength = AVAudioFrameCount(frameCount)
        let copyStatus = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frameCount),
            into: inputBuffer.mutableAudioBufferList
        )
        guard copyStatus == noErr else { return }

        let ratio = outputFormat.sampleRate / incoming.sampleRate
        let outputCapacity = AVAudioFrameCount(Double(frameCount) * ratio) + 64
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: outputCapacity) else {
            return
        }

        // Feed exactly one input buffer per conversion call. Returning
        // `.noDataNow` afterwards keeps the converter's resampler state
        // alive between buffers instead of flushing it, so consecutive
        // chunks join without clicks.
        var consumed = false
        var conversionError: NSError?
        let result = converter.convert(to: outputBuffer, error: &conversionError) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return inputBuffer
        }
        if result == .error {
            status("error \(conversionError?.localizedDescription ?? "audio conversion failed")")
            return
        }

        let byteCount = Int(outputBuffer.frameLength) * MemoryLayout<Int16>.size
        guard byteCount > 0, let channel = outputBuffer.int16ChannelData else { return }
        FileHandle.standardOutput.write(Data(bytes: channel[0], count: byteCount))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        status("error \(error.localizedDescription)")
        exit(4)
    }
}

guard #available(macOS 13.0, *) else {
    status("error requires macOS 13.0 or newer")
    exit(2)
}

let tap = SystemAudioTap()

func shutdown() {
    Task {
        await tap.stop()
        exit(0)
    }
}

signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { shutdown() }
termSource.resume()

signal(SIGINT, SIG_IGN)
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSource.setEventHandler { shutdown() }
intSource.resume()

Task {
    do {
        try await tap.start()
        status("ready")
    } catch {
        status("error \(error.localizedDescription)")
        exit(3)
    }
}

RunLoop.main.run()
