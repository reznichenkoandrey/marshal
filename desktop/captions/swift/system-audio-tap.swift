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
//   stderr — one status line per event: `ready`, `mic on`, `mic unavailable
//            <reason>`, `mic level <rms>` (with --verbose), `error <message>`
//   SIGTERM / SIGINT — stops the stream and exits 0
//
// Options:
//   --mic                 mix the microphone into the stream (#191). Uses
//                         ScreenCaptureKit's own microphone capture (macOS 15+),
//                         so both sources share one clock and one callback
//                         queue — no cross-process alignment needed.
//   --mic-device <uid>    Core Audio unique ID of the microphone; default input otherwise
//   --verbose             report the microphone level every ~5 s on stderr
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

    // Microphone mixing (#191). Mic samples are converted to the output
    // format and queued; every system-audio buffer then takes the same number
    // of samples off the queue and adds them in. Both callbacks arrive on
    // streamQueue, so the ring needs no lock.
    private var micConverter: AVAudioConverter?
    private var micInputFormat: AVAudioFormat?
    private var micRing: [Int16] = []
    private var micHead = 0
    private let micRingMax = 16_000 // 1 s: more than that means the system side stalled; drop the oldest
    private var micSumSquares: Double = 0
    private var micSampleCount = 0
    private var micLastReport = Date()
    var wantMicrophone = false
    var microphoneDeviceID: String? = nil
    var verbose = false

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

        var micArmed = false
        if wantMicrophone {
            if #available(macOS 15.0, *) {
                config.captureMicrophone = true
                config.microphoneCaptureDeviceID = microphoneDeviceID
                micArmed = true
            } else {
                status("mic unavailable requires macOS 15")
            }
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: streamQueue)
        if micArmed, #available(macOS 15.0, *) {
            try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: streamQueue)
        }
        try await stream.startCapture()
        self.stream = stream
        if micArmed { status("mic on") }
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
        guard sampleBuffer.isValid else { return }
        let isMic: Bool
        if #available(macOS 15.0, *), type == .microphone {
            isMic = true
        } else if type == .audio {
            isMic = false
        } else {
            return
        }
        guard let formatDescription = sampleBuffer.formatDescription,
              var streamDescription = formatDescription.audioStreamBasicDescription,
              let incoming = AVAudioFormat(streamDescription: &streamDescription)
        else { return }

        if isMic {
            if micConverter == nil || micInputFormat != incoming {
                micConverter = AVAudioConverter(from: incoming, to: outputFormat)
                micInputFormat = incoming
            }
        } else if converter == nil || inputFormat != incoming {
            converter = AVAudioConverter(from: incoming, to: outputFormat)
            inputFormat = incoming
        }
        guard let converter = isMic ? micConverter : converter else { return }

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

        let frames = Int(outputBuffer.frameLength)
        guard frames > 0, let channel = outputBuffer.int16ChannelData else { return }

        if isMic {
            enqueueMic(channel[0], count: frames)
            return
        }

        if micRing.count > micHead {
            // Sum with clipping: the other side of the call plus the user's
            // own voice, at their natural levels.
            for i in 0..<frames {
                let mic = takeMicSample()
                let mixed = Int32(channel[0][i]) + Int32(mic)
                channel[0][i] = Int16(max(-32768, min(32767, mixed)))
            }
        }
        FileHandle.standardOutput.write(Data(bytes: channel[0], count: frames * MemoryLayout<Int16>.size))
    }

    private func enqueueMic(_ samples: UnsafeMutablePointer<Int16>, count: Int) {
        if micHead > 0 && micHead >= micRing.count / 2 {
            micRing.removeFirst(micHead)
            micHead = 0
        }
        for i in 0..<count {
            let sample = samples[i]
            micRing.append(sample)
            if verbose {
                micSumSquares += Double(sample) * Double(sample)
                micSampleCount += 1
            }
        }
        let queued = micRing.count - micHead
        if queued > micRingMax {
            micHead += queued - micRingMax
        }
        if verbose, Date().timeIntervalSince(micLastReport) >= 5, micSampleCount > 0 {
            let rms = (micSumSquares / Double(micSampleCount)).squareRoot()
            status("mic level \(Int(rms))")
            micSumSquares = 0
            micSampleCount = 0
            micLastReport = Date()
        }
    }

    private func takeMicSample() -> Int16 {
        guard micHead < micRing.count else { return 0 }
        let sample = micRing[micHead]
        micHead += 1
        return sample
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
do {
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        switch args[i] {
        case "--mic":
            tap.wantMicrophone = true
        case "--mic-device":
            if i + 1 < args.count {
                let uid = args[i + 1].trimmingCharacters(in: .whitespacesAndNewlines)
                if !uid.isEmpty { tap.microphoneDeviceID = uid }
                i += 1
            }
        case "--verbose":
            tap.verbose = true
        default:
            status("ignoring unknown arg: \(args[i])")
        }
        i += 1
    }
}

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
