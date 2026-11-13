// desktop/assistant/wake/wake-listener.swift
//
// Hands-free wake phrase (#274). Holds the microphone while the assistant
// listens and runs a small sherpa-onnx keyword spotter over it; nothing is
// transcribed here. The spotter is a cheap, high-recall gate: it also fires on
// «маршрут» or "martial", so main transcribes every candidate with whisper and
// keeps it only when the utterance starts with the name.
//
// The sherpa-onnx runtime is downloaded on demand (not bundled) and loaded
// with dlopen; `sherpa-kws.h` pins the struct layout to v1.13.8.
//
// Audio comes through an AudioQueue, not AVAudioEngine: AVAudioEngine crashed
// with -10868 on AirPods (#52), and AudioQueue converts any input to 16 kHz
// mono itself.
//
// stdout, one line each:
//   ready              armed and listening
//   wake               the spotter fired; capture runs from ~2.5 s before it
//   level <dBFS>       every 100 ms while capturing (same format as audio-recorder --meter)
//   clip <path>        the capture was written as a 16 kHz mono 16-bit WAV
//   error <message>    fatal; the process exits 1
// stdin, one command per line:
//   end <path>         write the capture to <path>, then listen again
//   cancel             drop the capture, listen again
//   pause | resume     ignore the mic (Marshal speaking, dictation) / listen again
// EOF on stdin (main gone) stops the helper.
//
// Usage:
//   wake-listener --lib <sherpa lib dir> --model <kws model dir> --keywords <file>
//                 [--threshold 0.15] [--gate -50] [--wav <16 kHz mono 16-bit file>]

import AudioToolbox
import Foundation

let sampleRate = 16_000
let prerollSamples = sampleRate * 5 / 2
let chunkSamples = sampleRate / 10

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ line: String) {
  print(line)
}

func fail(_ message: String) -> Never {
  emit("error \(message)")
  exit(1)
}

var options: [String: String] = [:]
var argIndex = 1
while argIndex < CommandLine.arguments.count {
  let key = CommandLine.arguments[argIndex]
  guard key.hasPrefix("--"), argIndex + 1 < CommandLine.arguments.count else { fail("bad argument \(key)") }
  options[String(key.dropFirst(2))] = CommandLine.arguments[argIndex + 1]
  argIndex += 2
}
guard let libDir = options["lib"], let modelDir = options["model"], let keywordsFile = options["keywords"] else {
  fail("usage: wake-listener --lib <dir> --model <dir> --keywords <file> [--threshold <f>] [--wav <file>]")
}
let threshold = Float(options["threshold"] ?? "") ?? 0.15

// MARK: - sherpa-onnx through dlopen

guard let library = dlopen("\(libDir)/libsherpa-onnx-c-api.dylib", RTLD_NOW | RTLD_LOCAL) else {
  fail("cannot load sherpa-onnx: \(String(cString: dlerror()))")
}

func symbol<T>(_ name: String, as type: T.Type) -> T {
  guard let pointer = dlsym(library, name) else { fail("sherpa-onnx has no \(name)") }
  return unsafeBitCast(pointer, to: type)
}

typealias CreateSpotter = @convention(c) (UnsafePointer<SherpaOnnxKeywordSpotterConfig>) -> OpaquePointer?
typealias CreateStream = @convention(c) (OpaquePointer) -> OpaquePointer?
typealias AcceptWaveform = @convention(c) (OpaquePointer, Int32, UnsafePointer<Float>, Int32) -> Void
typealias IsReady = @convention(c) (OpaquePointer, OpaquePointer) -> Int32
typealias SpotterStream = @convention(c) (OpaquePointer, OpaquePointer) -> Void
typealias GetResult = @convention(c) (OpaquePointer, OpaquePointer) -> UnsafePointer<SherpaOnnxKeywordResult>?
typealias DestroyResult = @convention(c) (UnsafePointer<SherpaOnnxKeywordResult>) -> Void

let createSpotter = symbol("SherpaOnnxCreateKeywordSpotter", as: CreateSpotter.self)
let createStream = symbol("SherpaOnnxCreateKeywordStream", as: CreateStream.self)
let acceptWaveform = symbol("SherpaOnnxOnlineStreamAcceptWaveform", as: AcceptWaveform.self)
let isReady = symbol("SherpaOnnxIsKeywordStreamReady", as: IsReady.self)
let decode = symbol("SherpaOnnxDecodeKeywordStream", as: SpotterStream.self)
let resetStream = symbol("SherpaOnnxResetKeywordStream", as: SpotterStream.self)
let getResult = symbol("SherpaOnnxGetKeywordResult", as: GetResult.self)
let destroyResult = symbol("SherpaOnnxDestroyKeywordResult", as: DestroyResult.self)

// Config strings must outlive the create call; strdup'ed once, never freed.
func cString(_ value: String) -> UnsafePointer<CChar> {
  UnsafePointer(strdup(value))
}

let modelPrefix = "\(modelDir)/"
var config = SherpaOnnxKeywordSpotterConfig()
config.feat_config.sample_rate = Int32(sampleRate)
config.feat_config.feature_dim = 80
config.model_config.transducer.encoder = cString(modelPrefix + "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
config.model_config.transducer.decoder = cString(modelPrefix + "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
config.model_config.transducer.joiner = cString(modelPrefix + "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
config.model_config.tokens = cString(modelPrefix + "tokens.txt")
config.model_config.num_threads = 1
config.model_config.provider = cString("cpu")
config.max_active_paths = 4
config.num_trailing_blanks = 1
config.keywords_score = 1.0
config.keywords_threshold = threshold
config.keywords_file = cString(keywordsFile)

guard let spotter = withUnsafePointer(to: &config, { createSpotter($0) }) else { fail("cannot create the keyword spotter") }
guard let stream = createStream(spotter) else { fail("cannot create a keyword stream") }

// MARK: - Listening state (touched only on `work`)

enum Mode { case listening, capturing, paused }

let work = DispatchQueue(label: "wake-listener")
var mode = Mode.listening
var ring = [Float]()
var capture = [Float]()
var levelSamples = [Float]()
var spotting = false
var quietSamples = 0
let leadInSamples = sampleRate / 2
// ponytail: fixed gate under any speech in a quiet room; MARSHAL_WAKE_GATE_DB via --gate if a noisy room keeps it on.
let gateDb = Float(options["gate"] ?? "") ?? -50

func dbfs(_ samples: [Float]) -> Float {
  guard !samples.isEmpty else { return -160 }
  let power = samples.reduce(Float(0)) { $0 + $1 * $1 } / Float(samples.count)
  return power > 0 ? max(10 * log10(power), -160) : -160
}

func spot(_ samples: [Float]) -> Bool {
  samples.withUnsafeBufferPointer { acceptWaveform(stream, Int32(sampleRate), $0.baseAddress!, Int32(samples.count)) }
  var hit = false
  while isReady(spotter, stream) != 0 {
    decode(spotter, stream)
    guard let result = getResult(spotter, stream) else { continue }
    if let keyword = result.pointee.keyword, keyword.pointee != 0 {
      hit = true
      resetStream(spotter, stream)
    }
    destroyResult(result)
  }
  return hit
}

func reportLevels(_ samples: [Float]) {
  levelSamples.append(contentsOf: samples)
  while levelSamples.count >= chunkSamples {
    emit(String(format: "level %.1f", dbfs(Array(levelSamples.prefix(chunkSamples)))))
    levelSamples.removeFirst(chunkSamples)
  }
}

func feed(_ samples: [Float]) {
  switch mode {
  case .paused:
    return
  case .capturing:
    capture.append(contentsOf: samples)
    reportLevels(samples)
  case .listening:
    ring.append(contentsOf: samples)
    if ring.count > prerollSamples { ring.removeFirst(ring.count - prerollSamples) }
    // Silence costs nothing: the spotter only decodes while there is sound, and
    // starts a little before it so the first syllable is not cut.
    let loud = dbfs(samples) >= gateDb
    let wasSpotting = spotting
    spotting = loud || (spotting && quietSamples < sampleRate)
    quietSamples = loud ? 0 : quietSamples + samples.count
    guard spotting else { return }
    if !wasSpotting { resetStream(spotter, stream) }
    let input = wasSpotting ? samples : Array(ring.suffix(leadInSamples))
    if spot(input) {
      mode = .capturing
      capture = ring
      levelSamples = []
      emit("wake")
    }
  }
}

func listenAgain() {
  ring = []
  capture = []
  spotting = false
  quietSamples = 0
  resetStream(spotter, stream)
  mode = .listening
}

func writeWav(_ samples: [Float], to path: String) -> Bool {
  var data = Data()
  func append<T>(_ value: T) { withUnsafeBytes(of: value) { data.append(contentsOf: $0) } }
  let bytes = UInt32(samples.count * 2)
  data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36) + bytes)
  data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
  append(UInt32(sampleRate)); append(UInt32(sampleRate * 2)); append(UInt16(2)); append(UInt16(16))
  data.append(contentsOf: Array("data".utf8)); append(bytes)
  for sample in samples { append(Int16(max(-1, min(1, sample)) * Float(Int16.max)).littleEndian) }
  return FileManager.default.createFile(atPath: path, contents: data)
}

func handle(_ line: String) {
  let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
  switch parts.first {
  case "end":
    guard mode == .capturing, parts.count == 2 else { return }
    let path = parts[1]
    let written = writeWav(capture, to: path)
    listenAgain()
    emit(written ? "clip \(path)" : "error cannot write \(path)")
  case "cancel":
    if mode == .capturing { listenAgain() }
  case "pause":
    mode = .paused
    ring = []
    capture = []
  case "resume":
    if mode == .paused { listenAgain() }
  default:
    break
  }
}

Thread.detachNewThread {
  while let line = readLine() {
    work.async { handle(line.trimmingCharacters(in: .whitespaces)) }
  }
  exit(0)
}

// MARK: - Audio in

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
    work.sync { feed(chunk) }
    offset += chunkSamples
    usleep(100_000)
  }
  work.sync { feed([Float](repeating: 0, count: sampleRate)) }
  exit(0)
}

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

// A C callback cannot capture script state, so it reaches it through inUserData.
final class AudioSink {
  let deliver: ([Float]) -> Void
  init(_ deliver: @escaping ([Float]) -> Void) { self.deliver = deliver }
}
let sink = AudioSink { samples in work.async { feed(samples) } }

var queue: AudioQueueRef?
let callback: AudioQueueInputCallback = { userData, queue, buffer, _, _, _ in
  let count = Int(buffer.pointee.mAudioDataByteSize) / MemoryLayout<Float>.size
  let samples = Array(UnsafeBufferPointer(start: buffer.pointee.mAudioData.assumingMemoryBound(to: Float.self), count: count))
  Unmanaged<AudioSink>.fromOpaque(userData!).takeUnretainedValue().deliver(samples)
  AudioQueueEnqueueBuffer(queue, buffer, 0, nil)
}

var status = AudioQueueNewInput(&format, callback, Unmanaged.passUnretained(sink).toOpaque(), nil, nil, 0, &queue)
guard status == noErr, let queue else { fail("cannot open the microphone (\(status))") }
for _ in 0..<3 {
  var buffer: AudioQueueBufferRef?
  AudioQueueAllocateBuffer(queue, UInt32(chunkSamples * 4), &buffer)
  if let buffer { AudioQueueEnqueueBuffer(queue, buffer, 0, nil) }
}
status = AudioQueueStart(queue, nil)
guard status == noErr else { fail("cannot start the microphone (\(status))") }
emit("ready")

let signalSources = [SIGTERM, SIGINT].map { signalNumber -> DispatchSourceSignal in
  signal(signalNumber, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
  source.setEventHandler {
    AudioQueueStop(queue, true)
    exit(0)
  }
  source.resume()
  return source
}

dispatchMain()
