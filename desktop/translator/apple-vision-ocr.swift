// desktop/translator/apple-vision-ocr.swift
//
// Local OCR helper using macOS Vision. Reads an image file, returns the
// recognised text on stdout. Zero network, no API limits, works offline.
//
// On macOS 13+ we let Vision detect the dominant language automatically.
// On older systems we pin the set most relevant for this app (uk/en/ru).
//
// Usage:
//   apple-vision-ocr <image-path>
//
// Exit codes:
//   0 — success, text on stdout (may be empty if no text found)
//   1 — usage / I/O error
//   2 — Vision framework error

import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: apple-vision-ocr <image-path>\n".utf8))
    exit(1)
}

let imagePath = args[1]
let url = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: url),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write(Data("failed to load image at \(imagePath)\n".utf8))
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

if #available(macOS 13.0, *) {
    request.automaticallyDetectsLanguage = true
} else {
    // Most common scripts for this user base. Vision will pick the best match.
    request.recognitionLanguages = ["uk-UA", "en-US", "ru-RU"]
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])
    let observations = request.results ?? []
    let lines = observations.compactMap { $0.topCandidates(1).first?.string }
    let text = lines.joined(separator: "\n")
    if let data = text.data(using: .utf8) {
        FileHandle.standardOutput.write(data)
    }
} catch {
    FileHandle.standardError.write(Data("vision error: \(error.localizedDescription)\n".utf8))
    exit(2)
}
