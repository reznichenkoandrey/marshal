import { describe, expect, it } from "vitest";

import { toMeetingEntry } from "../desktop/meeting/meeting-library.ts";

const sizes = (known: Record<string, number>) => (p: string): number | null => known[p] ?? null;

describe("toMeetingEntry", () => {
  const finished = {
    id: "meeting-1",
    mode: "screen" as const,
    state: "done",
    startedAt: "2026-09-29T10:00:00.000Z",
    stoppedAt: "2026-09-29T10:45:30.000Z",
    audioPath: "/m/meeting-1/meeting.m4a",
    videoPath: "/m/meeting-1/meeting.mp4",
    warnings: []
  };

  it("reports duration, both files and their combined size", () => {
    const entry = toMeetingEntry(finished, "/m/meeting-1", sizes({
      "/m/meeting-1/meeting.m4a": 30,
      "/m/meeting-1/meeting.mp4": 900
    }), false);

    expect(entry).toMatchObject({ state: "done", mode: "screen", durationMs: 2_730_000, bytes: 930 });
    expect(entry?.videoPath).toBe("/m/meeting-1/meeting.mp4");
  });

  it("does not offer a player for a file that is gone from disk", () => {
    const entry = toMeetingEntry(finished, "/m/meeting-1", sizes({ "/m/meeting-1/meeting.m4a": 30 }), false);
    expect(entry?.videoPath).toBeNull();
    expect(entry?.audioPath).toBe("/m/meeting-1/meeting.m4a");
  });

  it("marks an unfinished folder interrupted unless it is the live recording", () => {
    const raw = { id: "meeting-2", state: "recording", startedAt: "2026-09-29T11:00:00.000Z" };
    expect(toMeetingEntry(raw, "/m/meeting-2", sizes({}), false)?.state).toBe("interrupted");
    expect(toMeetingEntry(raw, "/m/meeting-2", sizes({}), true)?.state).toBe("recording");
  });

  it("reads recordings made before modes existed as audio", () => {
    const legacy = {
      id: "meeting-old",
      state: "done",
      startedAt: "2026-06-12T08:00:00.000Z",
      audioPath: "/m/meeting-old/meeting.wav",
      transcriptPath: "/m/meeting-old/transcript.txt"
    };
    const entry = toMeetingEntry(legacy, "/m/meeting-old", sizes({ "/m/meeting-old/meeting.wav": 5 }), false);
    expect(entry).toMatchObject({ mode: "audio", state: "done", durationMs: null, bytes: 5 });
  });

  it("skips a manifest without an id", () => {
    expect(toMeetingEntry({ startedAt: "2026-09-29T10:00:00.000Z" }, "/m/x", sizes({}), false)).toBeNull();
  });
});
