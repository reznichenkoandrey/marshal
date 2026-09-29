// Reads the recordings MeetingRecorder left under <userData>/meetings/. The
// manifest is the source of truth for state and timing; file sizes come from
// disk so a half-finalized folder still shows what it actually holds.

import fs from "node:fs";
import path from "node:path";

import type { MeetingManifest, MeetingMode } from "./meeting-recorder.ts";

export type MeetingEntry = {
  id: string;
  mode: MeetingMode;
  state: MeetingManifest["state"] | "interrupted";
  startedAt: string;
  durationMs: number | null;
  folder: string;
  audioPath: string | null;
  videoPath: string | null;
  bytes: number;
  error: string | null;
  warnings: string[];
};

// Loose on purpose: recordings from before #229 carry `stitching` /
// `transcribing` states, a WAV audioPath and no mode.
type StoredManifest = Partial<Omit<MeetingManifest, "state">> & { state?: string };

export function toMeetingEntry(
  manifest: StoredManifest,
  folder: string,
  fileSize: (filePath: string) => number | null,
  isActive: boolean
): MeetingEntry | null {
  if (!manifest.id || !manifest.startedAt) return null;
  const audioSize = manifest.audioPath ? fileSize(manifest.audioPath) : null;
  const videoSize = manifest.videoPath ? fileSize(manifest.videoPath) : null;
  const started = Date.parse(manifest.startedAt);
  const stopped = manifest.stoppedAt ? Date.parse(manifest.stoppedAt) : Number.NaN;

  let state: MeetingEntry["state"];
  if (manifest.state === "error") state = "error";
  else if (audioSize !== null) state = "done";
  else if (isActive) state = manifest.state === "finalizing" ? "finalizing" : "recording";
  // A folder that is neither finished nor the live one lost its recorder
  // mid-call; its raw chunks are still on disk.
  else state = "interrupted";

  return {
    id: manifest.id,
    mode: manifest.mode ?? "audio",
    state,
    startedAt: manifest.startedAt,
    durationMs: Number.isFinite(stopped) && Number.isFinite(started) ? stopped - started : null,
    folder,
    audioPath: audioSize !== null ? manifest.audioPath ?? null : null,
    videoPath: videoSize !== null ? manifest.videoPath ?? null : null,
    bytes: (audioSize ?? 0) + (videoSize ?? 0),
    error: manifest.error ?? null,
    warnings: manifest.warnings ?? []
  };
}

export class MeetingLibrary {
  constructor(private readonly root: string) {}

  list(activeId: string | null): MeetingEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return [];
    }
    const entries: MeetingEntry[] = [];
    for (const name of names) {
      const folder = path.join(this.root, name);
      let manifest: StoredManifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")) as StoredManifest;
      } catch {
        continue;
      }
      const entry = toMeetingEntry(manifest, folder, statSize, manifest.id === activeId);
      if (entry) entries.push(entry);
    }
    return entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Resolves a renderer-supplied path only if it lives inside the library. */
  contains(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return resolved.startsWith(path.resolve(this.root) + path.sep);
  }

  folderFor(id: string): string | null {
    if (!/^[\w-]+$/u.test(id)) return null;
    const folder = path.join(this.root, id);
    return fs.existsSync(folder) ? folder : null;
  }
}

function statSize(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}
