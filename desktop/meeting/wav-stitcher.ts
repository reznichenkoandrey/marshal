import { promises as fs } from "node:fs";

type WavChunk = {
  data: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
};

export type WavFormat = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
};

export async function readWavFormat(filePath: string): Promise<WavFormat> {
  const chunk = parseWav(await fs.readFile(filePath), filePath);
  return {
    sampleRate: chunk.sampleRate,
    channels: chunk.channels,
    bitsPerSample: chunk.bitsPerSample,
    dataBytes: chunk.data.length
  };
}

export async function stitchWavPcm16Mono16k(inputPaths: string[], outputPath: string): Promise<WavFormat> {
  if (inputPaths.length === 0) {
    throw new Error("Cannot stitch a meeting recording without WAV chunks.");
  }

  const chunks = inputPaths.map(async (inputPath) => parseWav(await fs.readFile(inputPath), inputPath));
  const parsed = await Promise.all(chunks);
  for (const chunk of parsed) {
    if (chunk.sampleRate !== 16_000 || chunk.channels !== 1 || chunk.bitsPerSample !== 16) {
      throw new Error(
        `Unsupported WAV format: expected 16 kHz mono 16-bit PCM, got ` +
          `${chunk.sampleRate} Hz, ${chunk.channels} channel(s), ${chunk.bitsPerSample} bit.`
      );
    }
  }

  const dataBytes = parsed.reduce((sum, chunk) => sum + chunk.data.length, 0);
  if (dataBytes > 0xffff_ffff - 44) {
    throw new Error("Stitched WAV is too large for a RIFF/WAVE file.");
  }

  const out = Buffer.alloc(44 + dataBytes);
  writeWavHeader(out, dataBytes, 16_000, 1, 16);
  let offset = 44;
  for (const chunk of parsed) {
    chunk.data.copy(out, offset);
    offset += chunk.data.length;
  }
  await fs.writeFile(outputPath, out);
  return { sampleRate: 16_000, channels: 1, bitsPerSample: 16, dataBytes };
}

function parseWav(buffer: Buffer, source: string): WavChunk {
  if (buffer.length < 44) {
    throw new Error(`Invalid WAV chunk ${source}: file is too small.`);
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Invalid WAV chunk ${source}: missing RIFF/WAVE header.`);
  }

  let offset = 12;
  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let data: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const bodyOffset = offset + 8;
    const nextOffset = bodyOffset + size + (size % 2);
    if (bodyOffset + size > buffer.length) {
      throw new Error(`Invalid WAV chunk ${source}: ${id} section exceeds file size.`);
    }

    if (id === "fmt ") {
      if (size < 16) throw new Error(`Invalid WAV chunk ${source}: fmt section is too short.`);
      audioFormat = buffer.readUInt16LE(bodyOffset);
      channels = buffer.readUInt16LE(bodyOffset + 2);
      sampleRate = buffer.readUInt32LE(bodyOffset + 4);
      bitsPerSample = buffer.readUInt16LE(bodyOffset + 14);
    } else if (id === "data") {
      data = buffer.subarray(bodyOffset, bodyOffset + size);
    }

    offset = nextOffset;
  }

  if (audioFormat !== 1) throw new Error(`Invalid WAV chunk ${source}: only PCM WAV is supported.`);
  if (channels === null || sampleRate === null || bitsPerSample === null || data === null) {
    throw new Error(`Invalid WAV chunk ${source}: missing fmt or data section.`);
  }

  return { data, sampleRate, channels, bitsPerSample };
}

function writeWavHeader(
  buffer: Buffer,
  dataBytes: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number
): void {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
}
