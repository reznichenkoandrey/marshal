// desktop/presence/mic-users.swift
//
// Print one line per process that is capturing audio input right now:
// "<pid> <ppid> <bundle id>". Marshal reads it to tell whether the owner is
// on a call (#359): Meet, Zoom, Slack and Telegram all hold the mic open.
// Metadata only — no capture, no microphone permission. macOS 14+ (the
// process object list); older systems print nothing.

import CoreAudio
import Darwin
import Foundation

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func readScalar<T: BinaryInteger>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, as _: T.Type) -> T? {
  var addr = address(selector)
  var value: T = 0
  var size = UInt32(MemoryLayout<T>.size)
  let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0) }
  return status == noErr ? value : nil
}

func readBundleId(_ object: AudioObjectID) -> String {
  var addr = address(kAudioProcessPropertyBundleID)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr, let value else { return "" }
  return value.takeRetainedValue() as String
}

func parentPid(_ pid: pid_t) -> pid_t {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.size
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  return sysctl(&mib, 4, &info, &size, nil, 0) == 0 ? info.kp_eproc.e_ppid : 0
}

if #available(macOS 14.0, *) {
  var addr = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  if AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 {
    var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    if AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &objects) == noErr {
      for object in objects where readScalar(object, kAudioProcessPropertyIsRunningInput, as: UInt32.self) == 1 {
        guard let pid = readScalar(object, kAudioProcessPropertyPID, as: pid_t.self) else { continue }
        print("\(pid) \(parentPid(pid)) \(readBundleId(object))")
      }
    }
  }
}
