// desktop/dictation/mic-list.swift
//
// Enumerate macOS audio input devices via Core Audio HAL and emit a JSON
// array on stdout. Read by the settings UI to populate the Microphone
// dropdown so the user can pick which device dictation records from.
//
// Output (single line on stdout):
//   [{"id":"AppleHDAEngineInput:1F,3,0,1,0:1","name":"MacBook Pro Microphone",
//     "isDefault":true,"manufacturer":"Apple Inc.","transportType":"BuiltIn"},
//    {"id":"...", "name":"AirPods Pro", "isDefault":false, ...}]
//
// Exit 0 always — on any HAL failure emits `[]` and `[hal] ...` lines on
// stderr. Callers should never block on this — it's a dropdown, not the
// recording path.
//
// No microphone permission required: enumerating device IDs / names is a
// metadata query, not capture. The actual audio-recorder.swift handles TCC.

import Foundation
import CoreAudio

// ── HAL primitives ──

func readDeviceList() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    var err = AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize
    )
    guard err == noErr else {
        FileHandle.standardError.write("[hal] device list size: \(err)\n".data(using: .utf8)!)
        return []
    }
    let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
    if count == 0 { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: count)
    err = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &ids
    )
    guard err == noErr else {
        FileHandle.standardError.write("[hal] device list read: \(err)\n".data(using: .utf8)!)
        return []
    }
    return ids
}

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

func hasInputStreams(_ device: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreams,
        mScope: kAudioObjectPropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    let err = AudioObjectGetPropertyDataSize(device, &address, 0, nil, &dataSize)
    if err != noErr { return false }
    return dataSize > 0
}

func readStringProperty(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    // CoreAudio returns a +1 retained CFString here, so we use Unmanaged to
    // make ownership explicit and balance it with takeRetainedValue. Avoids
    // the Swift 6 overlapping-access trap from passing &cfString through a
    // nested pointer-rebind.
    var cfString: Unmanaged<CFString>?
    var dataSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let err = AudioObjectGetPropertyData(device, &address, 0, nil, &dataSize, &cfString)
    if err != noErr { return nil }
    guard let unmanaged = cfString else { return nil }
    return unmanaged.takeRetainedValue() as String
}

func readUInt32Property(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: UInt32 = 0
    var dataSize = UInt32(MemoryLayout<UInt32>.size)
    let err = AudioObjectGetPropertyData(device, &address, 0, nil, &dataSize, &value)
    return err == noErr ? value : nil
}

func transportTypeName(_ raw: UInt32?) -> String {
    guard let raw = raw else { return "Unknown" }
    switch raw {
    case kAudioDeviceTransportTypeBuiltIn: return "BuiltIn"
    case kAudioDeviceTransportTypeAggregate: return "Aggregate"
    case kAudioDeviceTransportTypeVirtual: return "Virtual"
    case kAudioDeviceTransportTypePCI: return "PCI"
    case kAudioDeviceTransportTypeUSB: return "USB"
    case kAudioDeviceTransportTypeFireWire: return "FireWire"
    case kAudioDeviceTransportTypeBluetooth: return "Bluetooth"
    case kAudioDeviceTransportTypeBluetoothLE: return "BluetoothLE"
    case kAudioDeviceTransportTypeHDMI: return "HDMI"
    case kAudioDeviceTransportTypeDisplayPort: return "DisplayPort"
    case kAudioDeviceTransportTypeAirPlay: return "AirPlay"
    case kAudioDeviceTransportTypeAVB: return "AVB"
    case kAudioDeviceTransportTypeThunderbolt: return "Thunderbolt"
    case kAudioDeviceTransportTypeContinuityCaptureWired: return "Continuity"
    case kAudioDeviceTransportTypeContinuityCaptureWireless: return "ContinuityWireless"
    default: return "Unknown"
    }
}

// ── JSON escaping ──

func jsonString(_ value: String) -> String {
    var out = "\""
    out.reserveCapacity(value.count + 2)
    for ch in value {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if let ascii = ch.asciiValue, ascii < 0x20 {
                out += String(format: "\\u%04x", Int(ascii))
            } else {
                out.append(ch)
            }
        }
    }
    out += "\""
    return out
}

// ── Main ──

let defaultDevice = readDefaultInputDevice()
let allDevices = readDeviceList()

struct MicEntry {
    let id: String
    let name: String
    let manufacturer: String
    let transportType: String
    let isDefault: Bool
}

var entries: [MicEntry] = []
for deviceID in allDevices {
    guard hasInputStreams(deviceID) else { continue }
    let uid = readStringProperty(deviceID, kAudioDevicePropertyDeviceUID) ?? ""
    let name = readStringProperty(deviceID, kAudioObjectPropertyName)
        ?? readStringProperty(deviceID, kAudioDevicePropertyDeviceNameCFString)
        ?? "(unnamed input \(deviceID))"
    let manufacturer = readStringProperty(deviceID, kAudioDevicePropertyDeviceManufacturerCFString) ?? ""
    let transport = transportTypeName(readUInt32Property(deviceID, kAudioDevicePropertyTransportType))
    let isDefault = (defaultDevice != nil) && (defaultDevice == deviceID)
    if uid.isEmpty { continue }   // can't be addressed by uniqueID — skip
    entries.append(MicEntry(
        id: uid, name: name, manufacturer: manufacturer,
        transportType: transport, isDefault: isDefault
    ))
}

// Stable order: default first, then by name. Makes the dropdown predictable
// for users and tests.
entries.sort { lhs, rhs in
    if lhs.isDefault != rhs.isDefault { return lhs.isDefault }
    return lhs.name.localizedCompare(rhs.name) == .orderedAscending
}

var json = "["
for (idx, entry) in entries.enumerated() {
    if idx > 0 { json += "," }
    json += "{\"id\":\(jsonString(entry.id))," +
        "\"name\":\(jsonString(entry.name))," +
        "\"isDefault\":\(entry.isDefault ? "true" : "false")," +
        "\"manufacturer\":\(jsonString(entry.manufacturer))," +
        "\"transportType\":\(jsonString(entry.transportType))}"
}
json += "]"
print(json)
exit(0)
