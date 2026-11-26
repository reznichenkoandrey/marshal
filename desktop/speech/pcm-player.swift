// desktop/speech/pcm-player.swift
//
// Plays raw s16le mono PCM from stdin while it arrives: `pcm-player <sample rate>`.
// Soniox synthesizes about as fast as it speaks, so waiting for the whole phrase before afplay
// cost 4–8 s per answer. Prints "started" once sound plays; on EOF it waits until every buffer
// has been played back, then exits 0. ffmpeg's audiotoolbox output exited with its queue unplayed (#522).

import AVFoundation
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let sampleRate = Double(CommandLine.arguments.dropFirst().first ?? "") ?? 24_000
guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false) else {
  FileHandle.standardError.write("bad sample rate\n".data(using: .utf8)!)
  exit(2)
}

let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
engine.attach(player)
engine.connect(player, to: engine.mainMixerNode, format: format)
do {
  try engine.start()
} catch {
  FileHandle.standardError.write("engine start failed: \(error)\n".data(using: .utf8)!)
  exit(3)
}

let played = DispatchGroup()
// A little audio in hand before play() so the first word does not stutter.
let prebufferBytes = Int(sampleRate * 0.2) * 2
let chunkBytes = Int(sampleRate * 0.1) * 2
var pending = Data()
var scheduledBytes = 0
var started = false

func schedule(_ data: Data) {
  let frames = data.count / 2
  guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
  buffer.frameLength = AVAudioFrameCount(frames)
  let out = buffer.floatChannelData![0]
  data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    let samples = raw.bindMemory(to: Int16.self)
    for index in 0..<frames { out[index] = Float(Int16(littleEndian: samples[index])) / 32_768 }
  }
  played.enter()
  player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in played.leave() }
  scheduledBytes += data.count
}

func startIfReady(force: Bool) {
  guard !started, force || scheduledBytes >= prebufferBytes else { return }
  player.play()
  started = true
  print("started")
}

while true {
  let data = FileHandle.standardInput.availableData
  if data.isEmpty { break }
  pending.append(data)
  if pending.count >= chunkBytes {
    let usable = pending.count - pending.count % 2
    schedule(pending.prefix(usable))
    pending = Data(pending.dropFirst(usable))
    startIfReady(force: false)
  }
}

schedule(pending)
if scheduledBytes == 0 { exit(0) }
startIfReady(force: true)
played.wait()
// The last buffer is "played back" when handed to hardware; let the device finish it.
Thread.sleep(forTimeInterval: 0.15)
exit(0)
