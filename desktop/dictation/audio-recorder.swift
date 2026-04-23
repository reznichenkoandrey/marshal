// desktop/dictation/audio-recorder.swift
//
// Minimal push-to-talk audio capture helper. Reads audio from the default
// input device, resamples to the format whisper.cpp expects (16 kHz mono
// 16-bit PCM WAV) and writes it to the path passed as the first argument.
//
// Lifecycle:
//   - start immediately on launch
//   - prints "ready" to stdout once engine is running (Node uses this as a
//     cue that it's safe to treat the process as recording)
//   - stops on SIGTERM / SIGINT, flushes the WAV file, then exits 0
//
// Usage:
//   audio-recorder /tmp/marshal-dict-<uuid>.wav
//
// Build is handled by scripts/postbuild.mjs (swiftc -O → dist/desktop/dictation/audio-recorder).
// Requires microphone permission (NSMicrophoneUsageDescription on the parent app).

import Foundation
import AVFoundation

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: audio-recorder <out.wav>\n".data(using: .utf8)!)
    exit(2)
}
let outPath = args[1]

// macOS 10.14+ requires explicit microphone permission. Without it, the
// input node hands us silent buffers and whisper.cpp returns an empty
// transcript — see #49. Block here until the user has answered the prompt
// so the failure mode is a loud error rather than a silent empty clipboard.
func ensureMicrophonePermission() {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    switch status {
    case .authorized:
        return
    case .denied, .restricted:
        FileHandle.standardError.write(
            "microphone permission denied — enable it in System Settings → Privacy & Security → Microphone, then restart Marshal\n".data(using: .utf8)!
        )
        exit(6)
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        var grantedLocal = false
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            grantedLocal = granted
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 30)
        if !grantedLocal {
            FileHandle.standardError.write("microphone permission not granted\n".data(using: .utf8)!)
            exit(6)
        }
    @unknown default:
        FileHandle.standardError.write("unknown microphone auth status — aborting\n".data(using: .utf8)!)
        exit(6)
    }
}

ensureMicrophonePermission()

let engine = AVAudioEngine()
let inputNode = engine.inputNode

// `inputFormat(forBus:0)` describes what the mic hands us. On some hardware
// (notably Bluetooth inputs like AirPods) `outputFormat(forBus:0)` returns a
// placeholder with 0 channels until the engine is prepared, which then breaks
// AUGraphParser::InitializeActiveNodesInInputChain (-10868, see #52).
let inputFormat = inputNode.inputFormat(forBus: 0)

guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
    FileHandle.standardError.write(
        "audio input device reports invalid format (sr=\(inputFormat.sampleRate), ch=\(inputFormat.channelCount)). Check System Settings → Sound → Input — the default device may be disconnected.\n"
            .data(using: .utf8)!
    )
    exit(7)
}

guard
    let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16000,
        channels: 1,
        interleaved: true
    ),
    let converter = AVAudioConverter(from: inputFormat, to: targetFormat)
else {
    FileHandle.standardError.write("failed to create target audio format / converter\n".data(using: .utf8)!)
    exit(3)
}

// Extended file settings so AVAudioFile writes a proper 16 kHz mono 16-bit
// WAV regardless of the input device's native rate.
let outSettings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatLinearPCM),
    AVSampleRateKey: 16000,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false
]

var outFile: AVAudioFile?
do {
    outFile = try AVAudioFile(forWriting: URL(fileURLWithPath: outPath), settings: outSettings)
} catch {
    FileHandle.standardError.write("failed to open output file: \(error)\n".data(using: .utf8)!)
    exit(4)
}

let bufferLock = NSLock()

inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
    let ratio = targetFormat.sampleRate / inputFormat.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio)
    guard
        capacity > 0,
        let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity)
    else { return }

    var provided = false
    var convError: NSError?
    converter.convert(to: converted, error: &convError) { _, outStatus in
        if provided {
            outStatus.pointee = .noDataNow
            return nil
        }
        provided = true
        outStatus.pointee = .haveData
        return buffer
    }
    if convError != nil || converted.frameLength == 0 { return }

    bufferLock.lock()
    defer { bufferLock.unlock() }
    try? outFile?.write(from: converted)
}

func shutdown() -> Never {
    engine.stop()
    inputNode.removeTap(onBus: 0)
    bufferLock.lock()
    outFile = nil  // release → deinit flushes header and closes the file
    bufferLock.unlock()
    exit(0)
}

// Use DispatchSource so Swift's async signal safety isn't violated. Ignore
// the default handler, let the source take over.
signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { shutdown() }
termSource.resume()

signal(SIGINT, SIG_IGN)
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSource.setEventHandler { shutdown() }
intSource.resume()

// `prepare()` wires up the graph and gives the audio subsystem a chance to
// resolve format mismatches before `start()` runs — without it, start() can
// bail with -10868 on Bluetooth inputs (#52).
engine.prepare()

do {
    try engine.start()
} catch {
    FileHandle.standardError.write("engine.start() failed: \(error)\n".data(using: .utf8)!)
    exit(5)
}

print("ready")
fflush(stdout)

dispatchMain()
