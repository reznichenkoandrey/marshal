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
// Device selection (#95): AVAudioRecorder always records from the system
// default input. To let the user pick a different mic without bouncing
// through System Settings, we optionally swap the default input on launch
// and restore it on shutdown. The swap is per-system, so it's racy in
// theory (another app starting input capture during our recording would
// also flip to our pick) but single-tenant input is the macOS norm.
//
// Lifecycle:
//   - parse args
//   - swap default input device if --device specified
//   - start recording immediately
//   - prints "ready" to stdout when armed (Node uses this as a signal that
//     it's safe to treat the process as recording)
//   - on SIGTERM / SIGINT: stop, flush WAV, restore previous default, exit 0
//
// Usage:
//   audio-recorder <out.wav>
//   audio-recorder <out.wav> --device <coreaudio-uniqueID>

import Foundation
import AVFoundation
import CoreAudio

// ── arg parsing ──

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(
        "usage: audio-recorder <out.wav> [--device <uniqueID>]\n".data(using: .utf8)!
    )
    exit(2)
}
let outPath = args[1]
let outURL = URL(fileURLWithPath: outPath)

var requestedDeviceUID: String? = nil
var i = 2
while i < args.count {
    let arg = args[i]
    if arg == "--device" && i + 1 < args.count {
        let raw = args[i + 1].trimmingCharacters(in: .whitespacesAndNewlines)
        if !raw.isEmpty { requestedDeviceUID = raw }
        i += 2
        continue
    }
    FileHandle.standardError.write("ignoring unknown arg: \(arg)\n".data(using: .utf8)!)
    i += 1
}

// ── microphone permission ──

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

// ── HAL helpers for device swap ──

func readDefaultInputDevice() -> AudioDeviceID? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var deviceID: AudioDeviceID = 0
    var dataSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    let err = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &deviceID
    )
    return err == noErr ? deviceID : nil
}

func setDefaultInputDevice(_ deviceID: AudioDeviceID) -> Bool {
    var deviceID = deviceID
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let err = AudioObjectSetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil,
        UInt32(MemoryLayout<AudioDeviceID>.size), &deviceID
    )
    return err == noErr
}

func findDeviceByUID(_ uid: String) -> AudioDeviceID? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    var err = AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize
    )
    guard err == noErr else { return nil }
    let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
    if count == 0 { return nil }
    var ids = [AudioDeviceID](repeating: 0, count: count)
    err = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &ids
    )
    guard err == noErr else { return nil }

    for deviceID in ids {
        var uidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var cfString: Unmanaged<CFString>?
        var uidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let uidErr = AudioObjectGetPropertyData(
            deviceID, &uidAddress, 0, nil, &uidSize, &cfString
        )
        if uidErr == noErr, let unmanaged = cfString {
            if (unmanaged.takeRetainedValue() as String) == uid { return deviceID }
        }
    }
    return nil
}

// ── device swap (best-effort) ──

let previousDefaultInput: AudioDeviceID? = readDefaultInputDevice()
var swappedInput = false

if let uid = requestedDeviceUID {
    if let deviceID = findDeviceByUID(uid) {
        if deviceID != previousDefaultInput {
            if setDefaultInputDevice(deviceID) {
                swappedInput = true
            } else {
                FileHandle.standardError.write(
                    "failed to set default input to \(uid); proceeding with system default\n".data(using: .utf8)!
                )
            }
        }
        // else: already the default — nothing to do.
    } else {
        FileHandle.standardError.write(
            "requested device \(uid) not present; proceeding with system default\n".data(using: .utf8)!
        )
    }
}

func restoreDefaultInput() {
    if swappedInput, let original = previousDefaultInput {
        _ = setDefaultInputDevice(original)
    }
}

// ── recorder setup ──

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
    restoreDefaultInput()
    FileHandle.standardError.write("AVAudioRecorder init failed: \(error)\n".data(using: .utf8)!)
    exit(4)
}

guard recorder.prepareToRecord() else {
    restoreDefaultInput()
    FileHandle.standardError.write(
        "prepareToRecord() returned false. Check System Settings → Sound → Input — the default device may be unavailable.\n".data(using: .utf8)!
    )
    exit(5)
}

guard recorder.record() else {
    restoreDefaultInput()
    FileHandle.standardError.write(
        "record() returned false. Verify that an input device is connected and selected in System Settings → Sound → Input.\n".data(using: .utf8)!
    )
    exit(5)
}

func shutdown() -> Never {
    // stop() flushes the WAV header and closes the file synchronously. Safe
    // to call from a DispatchSource signal handler on the main queue.
    recorder.stop()
    restoreDefaultInput()
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
