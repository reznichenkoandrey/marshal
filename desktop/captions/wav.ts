// desktop/captions/wav.ts
//
// Wraps a PCM segment in a RIFF header so whisper (local or Groq) can read
// it. The meeting recorder has its own stitcher for files on disk; this one
// works on in-memory samples, which is what the segmenter produces.

export function encodeWavPcm16Mono(samples: Int16Array, sampleRate = 16_000): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  const byteRate = sampleRate * 2;
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(byteRate, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    out.writeInt16LE(samples[i], 44 + i * 2);
  }
  return out;
}
