// desktop/assistant/speaker/speaker-embed.swift
//
// Speaker check (#287): turns audio files into speaker embeddings and exits.
// One process per check, so no model stays in memory between commands (#281).
//
// The sherpa-onnx runtime is downloaded on demand (not bundled) and loaded
// with dlopen; `sherpa-speaker.h` pins the struct layout to v1.13.8.
//
// stdout, one JSON object per line:
//   {"file":0,"start":0.0,"levelDb":-23.4,"embedding":[…]}   one per file, or one per window
//   {"file":0,"error":"…"}                                   this file gave nothing
// A fatal problem (no runtime, no model) prints {"error":"…"} and exits 1.
//
// Usage:
//   speaker-embed --lib <sherpa lib dir> --model <onnx> [--window <s> --hop <s>] <audio file>…
// Any format Core Audio reads (WAV, M4A, …); with --window each file is cut into
// overlapping windows (enrolment), without it the whole file is one embedding.

import AudioToolbox
import Foundation

let sampleRate = 16_000
// An enrolment file longer than this is cut: more adds minutes of work and nothing to the profile.
let maxSamples = sampleRate * 300
// Less than this is not enough speech for a stable embedding.
let minSamples = sampleRate / 2

func emit(_ line: String) {
  print(line)
}

func quoted(_ text: String) -> String {
  let data = try? JSONSerialization.data(withJSONObject: [text])
  let array = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
  return String(array.dropFirst().dropLast())
}

func fail(_ message: String) -> Never {
  emit("{\"error\":\(quoted(message))}")
  exit(1)
}

var options: [String: String] = [:]
var files: [String] = []
var argIndex = 1
while argIndex < CommandLine.arguments.count {
  let arg = CommandLine.arguments[argIndex]
  if arg.hasPrefix("--"), files.isEmpty {
    guard argIndex + 1 < CommandLine.arguments.count else { fail("bad argument \(arg)") }
    options[String(arg.dropFirst(2))] = CommandLine.arguments[argIndex + 1]
    argIndex += 2
  } else {
    files.append(arg)
    argIndex += 1
  }
}
guard let libDir = options["lib"], let modelPath = options["model"], !files.isEmpty else {
  fail("usage: speaker-embed --lib <dir> --model <onnx> [--window <s> --hop <s>] <audio file>…")
}
let windowSamples = (Double(options["window"] ?? "") ?? 0) * Double(sampleRate)
let hopSamples = max(Double(sampleRate) / 10, (Double(options["hop"] ?? "") ?? 1) * Double(sampleRate))

// MARK: - sherpa-onnx through dlopen

guard let library = dlopen("\(libDir)/libsherpa-onnx-c-api.dylib", RTLD_NOW | RTLD_LOCAL) else {
  fail("cannot load sherpa-onnx: \(String(cString: dlerror()))")
}

func symbol<T>(_ name: String, as type: T.Type) -> T {
  guard let pointer = dlsym(library, name) else { fail("sherpa-onnx has no \(name)") }
  return unsafeBitCast(pointer, to: type)
}

typealias CreateExtractor = @convention(c) (UnsafePointer<SherpaOnnxSpeakerEmbeddingExtractorConfig>) -> OpaquePointer?
typealias ExtractorDim = @convention(c) (OpaquePointer) -> Int32
typealias CreateStream = @convention(c) (OpaquePointer) -> OpaquePointer?
typealias AcceptWaveform = @convention(c) (OpaquePointer, Int32, UnsafePointer<Float>, Int32) -> Void
typealias StreamCall = @convention(c) (OpaquePointer) -> Void
typealias IsReady = @convention(c) (OpaquePointer, OpaquePointer) -> Int32
typealias Compute = @convention(c) (OpaquePointer, OpaquePointer) -> UnsafePointer<Float>?
typealias DestroyEmbedding = @convention(c) (UnsafePointer<Float>) -> Void

let createExtractor = symbol("SherpaOnnxCreateSpeakerEmbeddingExtractor", as: CreateExtractor.self)
let extractorDim = symbol("SherpaOnnxSpeakerEmbeddingExtractorDim", as: ExtractorDim.self)
let createStream = symbol("SherpaOnnxSpeakerEmbeddingExtractorCreateStream", as: CreateStream.self)
let acceptWaveform = symbol("SherpaOnnxOnlineStreamAcceptWaveform", as: AcceptWaveform.self)
let inputFinished = symbol("SherpaOnnxOnlineStreamInputFinished", as: StreamCall.self)
let destroyStream = symbol("SherpaOnnxDestroyOnlineStream", as: StreamCall.self)
let isReady = symbol("SherpaOnnxSpeakerEmbeddingExtractorIsReady", as: IsReady.self)
let compute = symbol("SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding", as: Compute.self)
let destroyEmbedding = symbol("SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding", as: DestroyEmbedding.self)

guard FileManager.default.fileExists(atPath: modelPath) else { fail("no model at \(modelPath)") }
var config = SherpaOnnxSpeakerEmbeddingExtractorConfig()
config.model = UnsafePointer(strdup(modelPath))
config.num_threads = 2
config.debug = 0
config.provider = UnsafePointer(strdup("cpu"))
guard let extractor = withUnsafePointer(to: &config, { createExtractor($0) }) else { fail("cannot create the speaker extractor") }
let dim = Int(extractorDim(extractor))

func embed(_ samples: ArraySlice<Float>) -> [Float]? {
  guard let stream = createStream(extractor) else { return nil }
  defer { destroyStream(stream) }
  samples.withUnsafeBufferPointer { acceptWaveform(stream, Int32(sampleRate), $0.baseAddress!, Int32($0.count)) }
  inputFinished(stream)
  guard isReady(extractor, stream) != 0, let vector = compute(extractor, stream) else { return nil }
  defer { destroyEmbedding(vector) }
  return Array(UnsafeBufferPointer(start: vector, count: dim))
}

// MARK: - Audio in

/// Any file Core Audio opens, converted to 16 kHz mono float.
func readAudio(_ path: String) -> [Float]? {
  var opened: ExtAudioFileRef?
  guard ExtAudioFileOpenURL(URL(fileURLWithPath: path) as CFURL, &opened) == noErr, let file = opened else { return nil }
  defer { ExtAudioFileDispose(file) }
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
  let size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
  guard ExtAudioFileSetProperty(file, kExtAudioFileProperty_ClientDataFormat, size, &format) == noErr else { return nil }
  var samples = [Float]()
  var chunk = [Float](repeating: 0, count: sampleRate)
  while samples.count < maxSamples {
    var frames = UInt32(chunk.count)
    let status = chunk.withUnsafeMutableBytes { raw -> OSStatus in
      var list = AudioBufferList(
        mNumberBuffers: 1,
        mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(raw.count), mData: raw.baseAddress)
      )
      return ExtAudioFileRead(file, &frames, &list)
    }
    guard status == noErr else { return nil }
    if frames == 0 { break }
    samples.append(contentsOf: chunk[0..<Int(frames)])
  }
  return samples
}

func dbfs(_ samples: ArraySlice<Float>) -> Float {
  guard !samples.isEmpty else { return -160 }
  let power = samples.reduce(Float(0)) { $0 + $1 * $1 } / Float(samples.count)
  return power > 0 ? max(10 * log10(power), -160) : -160
}

func report(file: Int, start: Double, samples: ArraySlice<Float>) -> Bool {
  guard let vector = embed(samples) else { return false }
  let values = vector.map { String(format: "%.6f", $0) }.joined(separator: ",")
  emit(String(format: "{\"file\":%d,\"start\":%.2f,\"levelDb\":%.1f,\"embedding\":[%@]}", file, start, dbfs(samples), values))
  return true
}

for (index, path) in files.enumerated() {
  guard let samples = readAudio(path) else {
    emit("{\"file\":\(index),\"error\":\"cannot read the audio\"}")
    continue
  }
  guard samples.count >= minSamples else {
    emit("{\"file\":\(index),\"error\":\"too short\"}")
    continue
  }
  var any = false
  if windowSamples >= Double(minSamples) {
    var start = 0.0
    while Int(start + windowSamples) <= samples.count {
      any = report(file: index, start: start / Double(sampleRate), samples: samples[Int(start)..<Int(start + windowSamples)]) || any
      start += hopSamples
    }
  } else {
    any = report(file: index, start: 0, samples: samples[...])
  }
  if !any { emit("{\"file\":\(index),\"error\":\"no embedding\"}") }
}
