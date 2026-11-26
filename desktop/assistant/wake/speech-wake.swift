// desktop/assistant/wake/speech-wake.swift
//
// Wake phrase on Apple's on-device dictation model (#432). Replaces the
// keyword spotter of wake-listener.swift where macOS 26+ has the Ukrainian
// dictation asset: on the owner's recordings it caught every «Маршал» the
// spotter missed, and its text is the command itself, so main skips whisper.
//
// Each stretch of sound above the energy gate gets a fresh SpeechAnalyzer:
// one stream fed with minutes of talk drifts to ~10 s of lag. In silence
// nothing is fed and nothing runs.
//
// stdout, one line each:
//   ready              armed and listening
//   partial <text>     volatile text of the current stretch, on every change
//   level <dBFS>       every 100 ms while held
//   final <text>       the held stretch, finalized after `end`
//   status <s>         with --status: installed | supported | unsupported
//   error <message>    fatal; the process exits 1
// stdin, one command per line:
//   hold [<path>]      main heard the name: keep this stretch open until end/cancel
//                      (already closed: `final` with its last text at once)
//   end [<path>]       finalize the held stretch, print `final`, listen again
//                      With <path> (speaker check, #287) the stretch's audio is written there
//                      as a 16 kHz mono 16-bit WAV before `final` is printed.
//   cancel             drop it, listen again
//   pause | resume     ignore the mic (Marshal speaking, dictation) / listen again
//   context <w>\t<w>…  words to expect (project names), from the next stretch on
// EOF on stdin (main gone) stops the helper.
//
// Usage:
//   speech-wake [--locale uk_UA] [--gate -50] [--wav <16 kHz mono 16-bit file>]
//   speech-wake --status [--locale uk_UA]
//   speech-wake --install [--locale uk_UA]

import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation
import Speech

let sampleRate = 16_000
let chunkSamples = sampleRate / 10
// A fresh analyzer drops its first ~0.5 s: with a 0.5 s lead-in «Маршал» came out as «Ми» or nothing.
let leadInSamples = sampleRate
// Unheld stretches end after this much quiet, or this long: room talk is not kept.
let quietToCloseSamples = sampleRate
let maxUnheldSamples = sampleRate * 12

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ line: String) {
  print(line)
}

func fail(_ message: String) -> Never {
  emit("error \(message)")
  exit(1)
}

var options: [String: String] = [:]
var flags = Set<String>()
var argIndex = 1
while argIndex < CommandLine.arguments.count {
  let key = CommandLine.arguments[argIndex]
  guard key.hasPrefix("--") else { fail("bad argument \(key)") }
  if key == "--status" || key == "--install" {
    flags.insert(String(key.dropFirst(2)))
    argIndex += 1
    continue
  }
  guard argIndex + 1 < CommandLine.arguments.count else { fail("bad argument \(key)") }
  options[String(key.dropFirst(2))] = CommandLine.arguments[argIndex + 1]
  argIndex += 2
}

let locale = Locale(identifier: options["locale"] ?? "uk_UA")
// ponytail: fixed gate under any speech in a quiet room, same as wake-listener; --gate if a noisy room keeps it on.
let gateDb = Float(options["gate"] ?? "") ?? -50

func dbfs(_ samples: [Float]) -> Float {
  guard !samples.isEmpty else { return -160 }
  let power = samples.reduce(Float(0)) { $0 + $1 * $1 } / Float(samples.count)
  return power > 0 ? max(10 * log10(power), -160) : -160
}

@available(macOS 26.0, *)
func makeTranscriber() -> DictationTranscriber {
  DictationTranscriber(locale: locale, contentHints: [.shortForm], transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
}

@available(macOS 26.0, *)
func assetStatus() async -> String {
  let supported = await DictationTranscriber.supportedLocales
  guard supported.contains(where: { $0.identifier == locale.identifier }) else { return "unsupported" }
  // AssetInventory.status reports this exact configuration as only "supported" while it transcribes fine.
  let installed = await DictationTranscriber.installedLocales
  return installed.contains(where: { $0.identifier == locale.identifier }) ? "installed" : "supported"
}

// MARK: - One stretch of sound

@available(macOS 26.0, *)
final class Stretch {
  let analyzer: SpeechAnalyzer
  let input: AsyncStream<AnalyzerInput>.Continuation
  let reader: Task<Void, Never>
  // Latest text per result range; touched only on `work`.
  var parts: [(start: Double, end: Double, text: String)] = []
  // The stretch's own audio, for the speaker check (#287); at most the 12 s an unheld stretch lives.
  var pcm = [Float]()
  var samples = 0
  var quietSamples = 0
  var held = false

  var text: String {
    parts.map(\.text).joined(separator: " ")
      .split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  init(onChange: @escaping (Stretch) -> Void) {
    let transcriber = makeTranscriber()
    analyzer = SpeechAnalyzer(modules: [transcriber])
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    input = continuation
    let analyzer = analyzer
    let words = contextWords
    var owner: Stretch?
    reader = Task {
      do {
        // Without it «Снорік» came out as «парі»: the model does not know the owner's project names.
        if !words.isEmpty {
          let context = AnalysisContext()
          context.contextualStrings[.general] = words
          try await analyzer.setContext(context)
        }
        try await analyzer.start(inputSequence: stream)
        for try await result in transcriber.results {
          let start = result.range.start.seconds
          let end = result.range.end.seconds
          let text = String(result.text.characters)
          work.async {
            guard let stretch = owner else { return }
            // A revision of the same words can come with a shifted range: it replaces whatever it overlaps.
            stretch.parts.removeAll { $0.end > start && $0.start < end }
            stretch.parts.append((start, end, text))
            stretch.parts.sort { $0.start < $1.start }
            onChange(stretch)
          }
        }
      } catch is CancellationError {
      } catch {
        work.async { emit("error transcriber: \(error.localizedDescription)") }
      }
    }
    owner = self
  }

  func feed(_ buffer: AVAudioPCMBuffer, pcm chunk: [Float]) {
    samples += chunk.count
    pcm.append(contentsOf: chunk)
    input.yield(AnalyzerInput(buffer: buffer))
  }

  /// Finalizes and hands the full text back on `work`.
  func finish(_ done: @escaping (String) -> Void) {
    input.finish()
    Task {
      try? await analyzer.finalizeAndFinishThroughEndOfInput()
      await reader.value
      work.async { done(self.text) }
    }
  }

  func drop() {
    input.finish()
    reader.cancel()
    Task { await analyzer.cancelAndFinishNow() }
  }
}

// MARK: - Listening state (touched only on `work`)

let work = DispatchQueue(label: "speech-wake")
var paused = false
var contextWords = [String]()
var ring = [Float]()
// Audio of the stretch that closed on quiet just before main's `hold` arrived.
var closedPcm = [Float]()

func writeWav(_ samples: [Float], to path: String) {
  var data = Data()
  func append<T>(_ value: T) { withUnsafeBytes(of: value) { data.append(contentsOf: $0) } }
  let bytes = UInt32(samples.count * 2)
  data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36) + bytes)
  data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
  append(UInt32(sampleRate)); append(UInt32(sampleRate * 2)); append(UInt16(2)); append(UInt16(16))
  data.append(contentsOf: Array("data".utf8)); append(bytes)
  for sample in samples { append(Int16(max(-1, min(1, sample)) * Float(Int16.max)).littleEndian) }
  FileManager.default.createFile(atPath: path, contents: data)
}

@available(macOS 26.0, *)
final class Listener {
  let format: AVAudioFormat
  let micFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false)!
  let converter: AVAudioConverter
  var stretch: Stretch?
  var lastPartial = ""

  init(format: AVAudioFormat) {
    self.format = format
    guard let converter = AVAudioConverter(from: micFormat, to: format) else { fail("cannot convert the mic to \(format)") }
    self.converter = converter
  }

  func convert(_ samples: [Float]) -> AVAudioPCMBuffer? {
    guard let source = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: AVAudioFrameCount(samples.count)) else { return nil }
    source.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { source.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
    let capacity = AVAudioFrameCount(Double(samples.count) * format.sampleRate / micFormat.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var consumed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return source
    }
    return error == nil ? out : nil
  }

  func feed(_ samples: [Float]) {
    if paused { return }
    ring.append(contentsOf: samples)
    if ring.count > leadInSamples { ring.removeFirst(ring.count - leadInSamples) }
    let level = dbfs(samples)
    let loud = level >= gateDb
    if stretch == nil {
      guard loud else { return }
      // Starts a little before the sound so the first syllable is not cut.
      lastPartial = ""
      closedPcm = []
      stretch = Stretch { [weak self] changed in self?.report(changed) }
      if let buffer = convert(ring) { stretch?.feed(buffer, pcm: ring) }
      return
    }
    guard let current = stretch else { return }
    if let buffer = convert(samples) { current.feed(buffer, pcm: samples) }
    if current.held {
      emit(String(format: "level %.1f", level))
      return
    }
    current.quietSamples = loud ? 0 : current.quietSamples + samples.count
    if current.quietSamples >= quietToCloseSamples || current.samples >= maxUnheldSamples {
      closedPcm = current.pcm
      current.drop()
      stretch = nil
    }
  }

  func report(_ changed: Stretch) {
    guard changed === stretch else { return }
    let text = changed.text
    guard !text.isEmpty, text != lastPartial else { return }
    lastPartial = text
    emit("partial \(text)")
  }

  func handle(_ line: String) {
    let words = line.split(separator: " ", maxSplits: 1).map(String.init)
    let clipPath = words.count == 2 ? words[1] : nil
    switch words.first {
    case "hold":
      // The stretch closed on quiet before main answered: hand back what it heard, main is waiting.
      guard let current = stretch else {
        if let clipPath, !closedPcm.isEmpty { writeWav(closedPcm, to: clipPath) }
        return emit("final \(lastPartial)")
      }
      current.held = true
    case "end":
      guard let current = stretch, current.held else { return emit("final") }
      stretch = nil
      if let clipPath { writeWav(current.pcm, to: clipPath) }
      current.finish { text in emit("final \(text)") }
    case "cancel":
      stretch?.drop()
      stretch = nil
    case "pause":
      paused = true
      ring = []
      closedPcm = []
      stretch?.drop()
      stretch = nil
    case "resume":
      paused = false
    case "context":
      contextWords = (words.count == 2 ? words[1] : "").split(separator: "\t").map(String.init)
    default:
      break
    }
  }
}

// MARK: - Entry

guard #available(macOS 26.0, *) else {
  if flags.contains("status") { emit("status unsupported"); exit(0) }
  fail("needs macOS 26 or later")
}

Task {
  if flags.contains("status") {
    emit("status \(await assetStatus())")
    exit(0)
  }
  if flags.contains("install") {
    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [makeTranscriber()]) {
        try await request.downloadAndInstall()
      }
      emit("status \(await assetStatus())")
      exit(0)
    } catch {
      fail("cannot install the \(locale.identifier) speech model: \(error.localizedDescription)")
    }
  }
  guard await assetStatus() == "installed" else { fail("the \(locale.identifier) speech model is not installed") }
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [makeTranscriber()]) else {
    fail("no audio format for the speech model")
  }
  let listener = Listener(format: format)

  Thread.detachNewThread {
    while let line = readLine() {
      work.async { listener.handle(line.trimmingCharacters(in: .whitespaces)) }
    }
    exit(0)
  }

  if let wav = options["wav"] {
    // Replays a file at real-time pace through the same path, for checks without a mic.
    guard let file = FileManager.default.contents(atPath: wav), let range = file.range(of: Data("data".utf8)) else { fail("cannot read \(wav)") }
    let pcm = file.subdata(in: (range.upperBound + 4)..<file.count)
    let samples: [Float] = pcm.withUnsafeBytes { raw in
      raw.bindMemory(to: Int16.self).map { Float(Int16(littleEndian: $0)) / Float(Int16.max) }
    }
    emit("ready")
    var offset = 0
    while offset < samples.count {
      let chunk = Array(samples[offset..<min(offset + chunkSamples, samples.count)])
      work.async { listener.feed(chunk) }
      offset += chunkSamples
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    // Trailing silence, so a stretch the file ends in can close or be ended.
    for _ in 0..<30 {
      work.async { listener.feed([Float](repeating: 0, count: chunkSamples)) }
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    return
  }

  startMicrophone { samples in work.async { listener.feed(samples) } }
  emit("ready")
}

// MARK: - Built-in microphone (#449)

// A Bluetooth headset drops from A2DP to HFP (call quality) as soon as any app opens its
// input, and stays there while it is open. Wake listening needs only the room's sound, so
// with a Bluetooth default input the queue is pinned to the built-in mic.
// Same code in wake-listener.swift: helpers compile one file each, so keep both in sync.
private func globalAudioProperty(_ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

private func transportType(of device: AudioDeviceID) -> UInt32? {
  var address = globalAudioProperty(kAudioDevicePropertyTransportType)
  var transport: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &transport) == noErr else { return nil }
  return transport
}

private func hasInput(_ device: AudioDeviceID) -> Bool {
  var address = globalAudioProperty(kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput)
  var size: UInt32 = 0
  return AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr && size > 0
}

private func defaultInputDevice() -> AudioDeviceID? {
  var address = globalAudioProperty(kAudioHardwarePropertyDefaultInputDevice)
  var device = AudioDeviceID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
        device != kAudioObjectUnknown else { return nil }
  return device
}

private func builtInInputUID() -> CFString? {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var address = globalAudioProperty(kAudioHardwarePropertyDevices)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return nil }
  var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &devices) == noErr else { return nil }
  for device in devices where transportType(of: device) == kAudioDeviceTransportTypeBuiltIn && hasInput(device) {
    var uidAddress = globalAudioProperty(kAudioDevicePropertyDeviceUID)
    var uid: CFString = "" as CFString
    var uidSize = UInt32(MemoryLayout<CFString>.size)
    if AudioObjectGetPropertyData(device, &uidAddress, 0, nil, &uidSize, &uid) == noErr { return uid }
  }
  return nil
}

// Call after AudioQueueNewInput and before AudioQueueStart.
private func pinBuiltInMicrophoneIfBluetooth(_ queue: AudioQueueRef) {
  guard let input = defaultInputDevice(), let transport = transportType(of: input),
        transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE,
        var uid = builtInInputUID() else { return }
  AudioQueueSetProperty(queue, kAudioQueueProperty_CurrentDevice, &uid, UInt32(MemoryLayout<CFString>.size))
}

// MARK: - Audio in

// A C callback cannot capture script state, so it reaches it through inUserData.
final class AudioSink {
  let deliver: ([Float]) -> Void
  init(_ deliver: @escaping ([Float]) -> Void) { self.deliver = deliver }
}

var audioSink: AudioSink?
var audioQueue: AudioQueueRef?

// AudioQueue, not AVAudioEngine: AVAudioEngine crashed with -10868 on AirPods (#52).
func startMicrophone(_ deliver: @escaping ([Float]) -> Void) {
  var format = AudioStreamBasicDescription(
    mSampleRate: Float64(sampleRate),
    mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kLinearPCMFormatFlagIsFloat | kLinearPCMFormatFlagIsPacked,
    mBytesPerPacket: 4,
    mFramesPerPacket: 1,
    mBytesPerFrame: 4,
    mChannelsPerFrame: 1,
    mBitsPerChannel: 32,
    mReserved: 0
  )
  let sink = AudioSink(deliver)
  audioSink = sink
  let callback: AudioQueueInputCallback = { userData, queue, buffer, _, _, _ in
    let count = Int(buffer.pointee.mAudioDataByteSize) / MemoryLayout<Float>.size
    let samples = Array(UnsafeBufferPointer(start: buffer.pointee.mAudioData.assumingMemoryBound(to: Float.self), count: count))
    Unmanaged<AudioSink>.fromOpaque(userData!).takeUnretainedValue().deliver(samples)
    AudioQueueEnqueueBuffer(queue, buffer, 0, nil)
  }
  var status = AudioQueueNewInput(&format, callback, Unmanaged.passUnretained(sink).toOpaque(), nil, nil, 0, &audioQueue)
  guard status == noErr, let queue = audioQueue else { fail("cannot open the microphone (\(status))") }
  pinBuiltInMicrophoneIfBluetooth(queue)
  for _ in 0..<3 {
    var buffer: AudioQueueBufferRef?
    AudioQueueAllocateBuffer(queue, UInt32(chunkSamples * 4), &buffer)
    if let buffer { AudioQueueEnqueueBuffer(queue, buffer, 0, nil) }
  }
  status = AudioQueueStart(queue, nil)
  guard status == noErr else { fail("cannot start the microphone (\(status))") }
}

let signalSources = [SIGTERM, SIGINT].map { signalNumber -> DispatchSourceSignal in
  signal(signalNumber, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
  source.setEventHandler {
    if let queue = audioQueue { AudioQueueStop(queue, true) }
    exit(0)
  }
  source.resume()
  return source
}

dispatchMain()
