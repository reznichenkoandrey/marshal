import { describe, expect, it } from "vitest";

import {
  buildMeetingAudioMixArgs,
  buildMeetingMuxArgs,
  buildTimelineToAacArgs
} from "../desktop/meeting/audio-mixer.ts";

describe("buildMeetingAudioMixArgs", () => {
  it("normalizes a microphone-only chunk to 48 kHz mono PCM", () => {
    expect(buildMeetingAudioMixArgs({ micPath: "/tmp/mic.wav", outputPath: "/tmp/out.wav" })).toEqual([
      "-y",
      "-i", "/tmp/mic.wav",
      "-vn",
      "-ar", "48000",
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

    expect(args.join(" ")).toContain("[mic][sys]amix=inputs=2:duration=longest:dropout_transition=0,volume=2[a]");
    expect(args).toContain("[a]");
    expect(args.at(-1)).toBe("/tmp/out.wav");
  });
});

describe("buildTimelineToAacArgs", () => {
  it("places every chunk at its wall-clock offset so rotation gaps stay as silence", () => {
    const args = buildTimelineToAacArgs(
      [
        { path: "/m/chunk-0001.wav", offsetMs: 0 },
        { path: "/m/chunk-0002.wav", offsetMs: 300_412.4 }
      ],
      "/m/meeting.m4a"
    );
    const graph = args[args.indexOf("-filter_complex") + 1];

    expect(graph).toBe(
      "[0:a]adelay=0:all=1[d0];[1:a]adelay=300412:all=1[d1];" +
        "[d0][d1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]"
    );
    expect(args.filter((arg) => arg === "-i")).toHaveLength(2);
    expect(args.slice(-5)).toEqual(["-b:a", "96k", "-movflags", "+faststart", "/m/meeting.m4a"]);
  });

  it("refuses an empty recording instead of producing a silent file", () => {
    expect(() => buildTimelineToAacArgs([], "/m/meeting.m4a")).toThrow(/without audio chunks/);
  });
});

describe("buildMeetingMuxArgs", () => {
  const base = { videoPath: "/m/screen.mov", audioPath: "/m/meeting.m4a", outputPath: "/m/meeting.mp4" };

  it("delays the audio when it started after the video", () => {
    expect(buildMeetingMuxArgs({ ...base, audioOffsetSec: 0.25 })).toEqual([
      "-y",
      "-i", "/m/screen.mov",
      "-itsoffset", "0.250", "-i", "/m/meeting.m4a",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c", "copy",
      "-movflags", "+faststart",
      "/m/meeting.mp4"
    ]);
  });

  it("delays the video when the audio started first", () => {
    const args = buildMeetingMuxArgs({ ...base, audioOffsetSec: -0.4 });
    expect(args.slice(1, 7)).toEqual(["-itsoffset", "0.400", "-i", "/m/screen.mov", "-i", "/m/meeting.m4a"]);
  });
});
