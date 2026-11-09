// Runs "Transcribe & summarize" for one recording (#271): cuts meeting.m4a
// at pauses, sends each piece to the local whisper.cpp (the resident server
// shared with dictation and captions, #218 — no second model), then asks the
// captions summarizer's provider stack for notes. The job lives in main, so
// closing the Meeting Recordings window does not stop it.
//
// One job at a time: the whisper server serialises requests anyway, and two
// hour-long jobs would only make a dictation phrase wait behind both.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSummaryStreamer, type SummaryStreamer } from "../captions/summarizer.ts";
import { isLikelyHallucination } from "../captions/transcript-buffer.ts";
import { createLocalWhisperBackend, isLocalWhisperAvailable, type WhisperBackend } from "../dictation/whisper-backend.ts";
import { MeetingAudioMixer } from "./audio-mixer.ts";
import {
  buildNotesMessages,
  formatTranscript,
  meetingNotesFiles,
  NOTES_MAX_TOKENS,
  parseFfmpegDurationMs,
  parseNotes,
  parseSilences,
  planTranscriptionChunks,
  renderNotesMarkdown,
  resolveNotesLanguage,
  type NotesLanguage,
  type TranscriptLine
} from "./meeting-notes.ts";

export type NotesProgress = {
  id: string;
  phase: "preparing" | "transcribing" | "summarizing";
  done: number;
  total: number;
};

export type NotesJobInput = {
  id: string;
  folder: string;
  audioPath: string;
  startedAt: string;
  language: NotesLanguage;
};

export type NotesServiceDeps = {
  whisper?: () => WhisperBackend | null;
  summarizer?: () => SummaryStreamer | null;
};

// Quieter than -35 dB for 0.3 s or longer is a pause worth cutting at.
const SILENCE_FILTER = "silencedetect=noise=-35dB:d=0.3";

export class MeetingNotesService {
  private job: { input: NotesJobInput; controller: AbortController; progress: NotesProgress } | null = null;
  private readonly whisper: () => WhisperBackend | null;
  private readonly summarizer: () => SummaryStreamer | null;

  constructor(
    private readonly onProgress: (progress: NotesProgress | null) => void,
    deps: NotesServiceDeps = {}
  ) {
    this.whisper = deps.whisper ?? (() => (isLocalWhisperAvailable() ? createLocalWhisperBackend() : null));
    this.summarizer = deps.summarizer ?? (() => createSummaryStreamer(process.env));
  }

  current(): NotesProgress | null {
    return this.job?.progress ?? null;
  }

  cancel(id: string): boolean {
    if (this.job?.input.id !== id) return false;
    this.job.controller.abort();
    return true;
  }

  async run(input: NotesJobInput): Promise<{ ok: boolean; error?: string }> {
    if (this.job) {
      return {
        ok: false,
        error: this.job.input.id === input.id ? "Already in progress." : "Another recording is being transcribed."
      };
    }
    const controller = new AbortController();
    this.job = { input, controller, progress: { id: input.id, phase: "preparing", done: 0, total: 0 } };
    this.onProgress(this.job.progress);
    try {
      const files = meetingNotesFiles(input.folder);
      // A transcript on disk is complete (it is written last), so "Regenerate"
      // after a failed or unwanted summary costs one model call, not the STT.
      let transcript = await fs.readFile(files.transcript, "utf8").catch(() => null);
      if (transcript === null) {
        transcript = await this.transcribe(input.audioPath, controller.signal);
        await fs.writeFile(files.transcript, transcript, "utf8");
      }
      if (transcript.trim().length === 0) throw new Error("No speech was recognised in this recording.");

      const summarizer = this.summarizer();
      if (!summarizer) {
        throw new Error(
          "Transcript saved, but no summary provider is configured: set ANTHROPIC_API_KEY or MARSHAL_API_KEY."
        );
      }
      this.report({ phase: "summarizing", done: 0, total: 1 });
      const language = resolveNotesLanguage(input.language, transcript);
      const answer = await summarizer.streamMessages(
        buildNotesMessages(transcript, language),
        NOTES_MAX_TOKENS,
        () => undefined,
        controller.signal
      );
      const notes = parseNotes(answer);
      await fs.writeFile(
        files.notesJson,
        JSON.stringify(
          { ...notes, language, requestedLanguage: input.language, provider: summarizer.id, generatedAt: new Date().toISOString() },
          null,
          2
        ),
        "utf8"
      );
      await fs.writeFile(files.notesMd, renderNotesMarkdown(notes, language, input.startedAt), "utf8");
      return { ok: true };
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, error: "Cancelled." };
      return { ok: false, error: (err as Error).message };
    } finally {
      this.job = null;
      this.onProgress(null);
    }
  }

  private report(update: Omit<NotesProgress, "id">): void {
    if (!this.job) return;
    this.job.progress = { id: this.job.input.id, ...update };
    this.onProgress(this.job.progress);
  }

  private async transcribe(audioPath: string, signal: AbortSignal): Promise<string> {
    const whisper = this.whisper();
    if (!whisper) {
      throw new Error("The local dictation model is not installed. Tray → Download Dictation Model…, then try again.");
    }
    const probe = await runFfmpeg(["-nostats", "-i", audioPath, "-af", SILENCE_FILTER, "-f", "null", "-"], signal);
    const durationMs = parseFfmpegDurationMs(probe);
    if (durationMs === null) throw new Error("Could not read the length of the recording.");
    const chunks = planTranscriptionChunks(durationMs, parseSilences(probe));

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "marshal-notes-"));
    try {
      const lines: TranscriptLine[] = [];
      for (const chunk of chunks) {
        if (signal.aborted) throw new Error("Cancelled.");
        this.report({ phase: "transcribing", done: chunk.index, total: chunks.length });
        const wav = path.join(tmp, `chunk-${chunk.index}.wav`);
        await runFfmpeg(
          [
            "-loglevel", "error",
            "-ss", (chunk.startMs / 1000).toFixed(3),
            "-t", ((chunk.endMs - chunk.startMs) / 1000).toFixed(3),
            "-i", audioPath,
            "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            "-y", wav
          ],
          signal
        );
        // Language left to whisper per chunk: a call can switch between
        // Ukrainian and English, and 25 s is enough for detection to hold.
        const result = await whisper.transcribe(wav);
        await fs.unlink(wav).catch(() => undefined);
        const text = result.text.replace(/\s+/gu, " ").trim();
        if (!isLikelyHallucination(text)) lines.push({ startMs: chunk.startMs, text });
      }
      return lines.length > 0 ? formatTranscript(lines) : "";
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Runs ffmpeg and resolves with its stderr; killed when `signal` aborts. */
function runFfmpeg(args: string[], signal: AbortSignal): Promise<string> {
  const bin = MeetingAudioMixer.getBinaryPath();
  if (!bin) return Promise.reject(new Error("ffmpeg binary not found. Install dependencies with `npm install`."));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-hide_banner", ...args], { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}
