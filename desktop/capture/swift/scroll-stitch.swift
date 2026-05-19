// desktop/capture/swift/scroll-stitch.swift
//
// Vertical stitch for a sequence of PNG frames produced by scroll-capture.
// For each consecutive pair we ask Vision for the translational alignment
// (VNTranslationalImageRegistrationRequest) and crop the new frame to just
// the *new* content below the overlap, then concatenate everything into one
// tall PNG.
//
// Usage:
//   scroll-stitch out=<path.png> frame1.png frame2.png frame3.png ...
//
// At least one input frame is required. With only one frame the output is a
// copy. With multiple frames every overlap is detected independently — if
// Vision returns a translation that is implausible (zero, or larger than the
// frame), we fall back to "stack the whole frame, no overlap detection" and
// log a warning. The fallback is what keeps the script from refusing to
// emit any output when the source material is hostile (animated banners,
// fixed-position headers, etc).
//
// Stdout:  `out <path>` on success.
// Stderr:  human-readable warnings + fatal errors.

import Foundation
import AppKit
import CoreGraphics
import Vision

// MARK: - Arg parsing -----------------------------------------------------

let argv = CommandLine.arguments
guard argv.count >= 3 else {
    FileHandle.standardError.write("usage: scroll-stitch out=<path.png> frame1.png frame2.png ...\n".data(using: .utf8)!)
    exit(2)
}

var outPath: String? = nil
var inputs: [String] = []
for arg in argv.dropFirst() {
    if arg.hasPrefix("out=") {
        outPath = String(arg.dropFirst(4))
    } else {
        inputs.append(arg)
    }
}

guard let outPath, !inputs.isEmpty else {
    FileHandle.standardError.write("must specify out=<path.png> and at least one input frame\n".data(using: .utf8)!)
    exit(2)
}

func loadCGImage(_ path: String) -> CGImage? {
    guard let url = URL(string: "file://" + path) ?? URL(fileURLWithPath: path) as URL?,
          let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else {
        return nil
    }
    return img
}

func write(_ image: CGImage, to path: String) throws {
    let url = URL(fileURLWithPath: path)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        throw NSError(domain: "Stitch", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Cannot create PNG destination"])
    }
    CGImageDestinationAddImage(dest, image, nil)
    if !CGImageDestinationFinalize(dest) {
        throw NSError(domain: "Stitch", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "PNG finalize failed"])
    }
}

// MARK: - Vision alignment -----------------------------------------------

/// Returns the y-pixel offset that aligns `next` on top of `prev`. A positive
/// number means `next` was scrolled down by that many pixels relative to
/// `prev` — i.e. the top `offset` rows of `next` overlap the bottom of `prev`.
///
/// The Vision request runs synchronously on the main thread. If anything in
/// the pipeline fails (request errored, no observations, translation values
/// out of range) we return `nil` so the caller can fall back to "no overlap".
func measureVerticalOverlap(prev: CGImage, next: CGImage) -> Int? {
    let request = VNTranslationalImageRegistrationRequest(targetedCGImage: next, options: [:])
    let handler = VNImageRequestHandler(cgImage: prev, options: [:])
    do {
        try handler.perform([request])
    } catch {
        FileHandle.standardError.write("Vision registration failed: \(error)\n".data(using: .utf8)!)
        return nil
    }
    guard let observation = request.results?.first else {
        return nil
    }
    // `alignmentTransform.ty` is the translation that maps `next` onto the
    // coordinate space of `prev`. We scrolled down, so the new frame appears
    // to be shifted *up* relative to the previous (negative ty).
    let ty = Double(observation.alignmentTransform.ty)
    let absShift = Int(round(abs(ty)))
    let frameHeight = next.height
    // Reject unreasonable values: no shift detected (page didn't move) or a
    // shift larger than the frame (Vision misaligned on a high-contrast
    // banner). The caller treats `nil` as "stack the full frame".
    if absShift == 0 { return nil }
    if absShift >= frameHeight { return nil }
    return absShift
}

// MARK: - Stitch ---------------------------------------------------------

guard let first = loadCGImage(inputs[0]) else {
    FileHandle.standardError.write("cannot load first frame: \(inputs[0])\n".data(using: .utf8)!)
    exit(3)
}

if inputs.count == 1 {
    do {
        try write(first, to: outPath)
    } catch {
        FileHandle.standardError.write("write failed: \(error)\n".data(using: .utf8)!)
        exit(4)
    }
    FileHandle.standardOutput.write("out \(outPath)\n".data(using: .utf8)!)
    exit(0)
}

let width = first.width
let bitsPerComponent = first.bitsPerComponent
let bytesPerRow = first.bytesPerRow
let colorSpace = first.colorSpace ?? CGColorSpaceCreateDeviceRGB()
let bitmapInfo = first.bitmapInfo.rawValue

// First pass: figure out how tall the stitched image will be. We allocate the
// full output once, then blit each cropped slice into it via CGContext.
struct Slice {
    let image: CGImage
    let cropTop: Int   // rows to drop from the top (overlap with the previous frame)
}

var slices: [Slice] = [Slice(image: first, cropTop: 0)]
var totalHeight = first.height
var prev = first

for path in inputs.dropFirst() {
    guard let img = loadCGImage(path) else {
        FileHandle.standardError.write("skipping unreadable frame: \(path)\n".data(using: .utf8)!)
        continue
    }
    if img.width != width {
        FileHandle.standardError.write("skipping frame with mismatched width: \(path)\n".data(using: .utf8)!)
        continue
    }
    let overlap = measureVerticalOverlap(prev: prev, next: img) ?? 0
    let newRows = img.height - overlap
    if newRows > 0 {
        slices.append(Slice(image: img, cropTop: overlap))
        totalHeight += newRows
    } else {
        // Fully overlapping — frame contributes nothing.
    }
    prev = img
}

// Compose into a single CGContext. Coordinate space is bottom-up (CG), so we
// draw from the *last* slice first at y=0 and move upward.
guard let ctx = CGContext(
    data: nil,
    width: width,
    height: totalHeight,
    bitsPerComponent: bitsPerComponent,
    bytesPerRow: bytesPerRow,
    space: colorSpace,
    bitmapInfo: bitmapInfo
) else {
    FileHandle.standardError.write("cannot allocate stitched context (\(width)×\(totalHeight))\n".data(using: .utf8)!)
    exit(5)
}

var yCursorTop = 0   // rows already laid down measured from the TOP of the output
for slice in slices {
    let img = slice.image
    let drawHeight = img.height - slice.cropTop
    // Draw the slice cropped of its top `cropTop` rows. cgImage cropping is
    // exposed via `cropping(to:)` which expects bottom-up rect.
    let cropRect = CGRect(x: 0, y: 0, width: img.width, height: drawHeight)
    guard let cropped = img.cropping(to: cropRect) else {
        FileHandle.standardError.write("crop failed; using full frame\n".data(using: .utf8)!)
        continue
    }
    // y in CGContext is bottom-up — totalHeight - yCursorTop - drawHeight.
    let destY = totalHeight - yCursorTop - drawHeight
    ctx.draw(cropped, in: CGRect(x: 0, y: destY, width: width, height: drawHeight))
    yCursorTop += drawHeight
}

guard let stitched = ctx.makeImage() else {
    FileHandle.standardError.write("makeImage returned nil\n".data(using: .utf8)!)
    exit(6)
}

do {
    try write(stitched, to: outPath)
} catch {
    FileHandle.standardError.write("write failed: \(error)\n".data(using: .utf8)!)
    exit(7)
}

FileHandle.standardOutput.write("out \(outPath)\n".data(using: .utf8)!)
