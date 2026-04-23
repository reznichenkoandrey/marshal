// desktop/dictation/audio-recorder.swift
//
// Push-to-talk audio capture helper. Writes a 16 kHz mono 16-bit PCM WAV to
// the path passed as the first argument — the format whisper.cpp expects.
//
// Uses AVAudioRecorder (not AVAudioEngine) on purpose — it's the Apple-blessed
// "record a file" API, handles input-device quirks (Bluetooth inputs like
// AirPods, USB mics, built-in) and cross-device switches mid-session, and
// writes a proper WAV header on stop(). Previous AVAudioEngine implementation
// crashed with -10868 (AUGraphParser) on AirPods. See #52, #53.
//
// Lifecycle:
//   - start recording immediately on launch
//   - prints "ready" to stdout when the recorder is armed (Node uses this as
//     a signal that it's safe to treat the process as recording)
//   - stops on SIGTERM / SIGINT, flushes the WAV file, then exits 0
//
// Usage:
//   audio-recorder /tmp/marshal-dict-<uuid>.wav

import Foundation
import AVFoundation

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: audio-recorder <out.wav>\n".data(using: .utf8)!)
    exit(2)
}
let outPath = args[1]
let outURL = URL(fileURLWithPath: outPath)

// macOS 10.14+ requires explicit microphone permission. Without it the
// recorder silently captures zeros — surface the failure as exit(6) instead.
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

// whisper.cpp expects 16 kHz mono 16-bit PCM WAV. AVAudioRecorder resamples
// from whatever the input device natively produces — AirPods 24 kHz, built-in
// 48 kHz, USB mics 44.1 kHz, all end up in this one format.
let settings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatLinearPCM),
    AVSampleRateKey: 16000,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false
]

var recorder: AVAudioRecorder
do {
    recorder = try AVAudioRecorder(url: outURL, settings: settings)
} catch {
    FileHandle.standardError.write("AVAudioRecorder init failed: \(error)\n".data(using: .utf8)!)
    exit(4)
}

guard recorder.prepareToRecord() else {
    FileHandle.standardError.write(
        "prepareToRecord() returned false. Check System Settings → Sound → Input — the default device may be unavailable.\n".data(using: .utf8)!
    )
    exit(5)
}

guard recorder.record() else {
    FileHandle.standardError.write(
        "record() returned false. Verify that an input device is connected and selected in System Settings → Sound → Input.\n".data(using: .utf8)!
    )
    exit(5)
}

func shutdown() -> Never {
    // stop() flushes the WAV header and closes the file synchronously. Safe
    // to call from a DispatchSource signal handler on the main queue.
    recorder.stop()
    exit(0)
}

signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { shutdown() }
termSource.resume()

signal(SIGINT, SIG_IGN)
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSource.setEventHandler { shutdown() }
intSource.resume()

print("ready")
fflush(stdout)

dispatchMain()
