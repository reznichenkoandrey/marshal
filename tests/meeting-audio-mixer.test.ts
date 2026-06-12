import { describe, expect, it } from "vitest";

import { buildMeetingAudioMixArgs } from "../desktop/meeting/audio-mixer.ts";

describe("buildMeetingAudioMixArgs", () => {
  it("normalizes a microphone-only chunk to Whisper WAV format", () => {
    expect(buildMeetingAudioMixArgs({ micPath: "/tmp/mic.wav", outputPath: "/tmp/out.wav" })).toEqual([
      "-y",
      "-i", "/tmp/mic.wav",
      "-vn",
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      "/tmp/out.wav"
    ]);
  });

  it("mixes microphone and system audio into one mono PCM stream", () => {
    const args = buildMeetingAudioMixArgs({
      micPath: "/tmp/mic.wav",
      systemPath: "/tmp/system.m4a",
      outputPath: "/tmp/out.wav"
    });

    expect(args).toContain("-filter_complex");
    expect(args.join(" ")).toContain("[mic][sys]amix=inputs=2:duration=longest:dropout_transition=0,volume=2[a]");
    expect(args).toContain("-map");
    expect(args).toContain("[a]");
    expect(args.at(-1)).toBe("/tmp/out.wav");
  });
});
