// tests/meeting-notes.test.ts
//
// "Transcribe & summarize" for meeting recordings (#271): cut points over
// pauses, the ffmpeg log parsers, the notes prompt contract and its parser,
// notes.md, and a full run of the service over a real m4a with the real
// ffmpeg and stubbed whisper / summarizer.

import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SummaryMessages } from "../desktop/captions/summary-prompt.ts";
import type { SummaryProviderId, SummaryStreamer } from "../desktop/captions/summarizer.ts";
import type { TranscribeResult, WhisperBackend } from "../desktop/dictation/whisper-backend.ts";
import { MeetingAudioMixer } from "../desktop/meeting/audio-mixer.ts";
import { toMeetingEntry } from "../desktop/meeting/meeting-library.ts";
import {
  buildNotesMessages,
  DEFAULT_CHUNK_PLAN,
  formatTranscript,
  meetingNotesFiles,
  NOTES_SYSTEM_PROMPT,
  parseFfmpegDurationMs,
  parseNotes,
  parseNotesLanguage,
  parseSilences,
  planTranscriptionChunks,
  renderNotesMarkdown,
  resolveNotesLanguage,
  transcriptLanguage
} from "../desktop/meeting/meeting-notes.ts";
import { MeetingNotesService, type NotesProgress } from "../desktop/meeting/meeting-notes-service.ts";

describe("planTranscriptionChunks", () => {
  it("keeps a short recording in one chunk", () => {
    expect(planTranscriptionChunks(20_000, [])).toEqual([{ index: 0, startMs: 0, endMs: 20_000 }]);
  });

  it("returns nothing for an empty or unknown length", () => {
    expect(planTranscriptionChunks(0, [])).toEqual([]);
    expect(planTranscriptionChunks(Number.NaN, [])).toEqual([]);
  });

  it("cuts in the middle of every turn pause", () => {
    const chunks = planTranscriptionChunks(32_000, [
      { startMs: 6_000, endMs: 6_300 }, // between two sentences of one speaker: too short to be a turn
      { startMs: 13_000, endMs: 14_500 },
      { startMs: 24_500, endMs: 26_000 }
    ]);
    expect(chunks).toEqual([
      { index: 0, startMs: 0, endMs: 13_750 },
      { index: 1, startMs: 13_750, endMs: 25_250 },
      { index: 2, startMs: 25_250, endMs: 32_000 }
    ]);
  });

  it("does not cut a chunk shorter than the minimum or leave a short tail", () => {
    const chunks = planTranscriptionChunks(20_000, [
      { startMs: 1_000, endMs: 2_000 },
      { startMs: 18_000, endMs: 19_000 }
    ]);
    expect(chunks).toEqual([{ index: 0, startMs: 0, endMs: 20_000 }]);
  });

  it("without a turn, cuts a long stretch at its longest pause", () => {
    const chunks = planTranscriptionChunks(40_000, [
      { startMs: 10_000, endMs: 10_400 },
      { startMs: 20_000, endMs: 20_500 },
      { startMs: 33_000, endMs: 33_200 }
    ]);
    expect(chunks.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 20_250],
      [20_250, 40_000]
    ]);
  });

  it("cuts hard at the maximum when there is no pause at all", () => {
    const chunks = planTranscriptionChunks(70_000, []);
    expect(chunks.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 30_000],
      [30_000, 60_000],
      [60_000, 70_000]
    ]);
  });

  it("never leaves a sliver at the end", () => {
    const chunks = planTranscriptionChunks(30_500, []);
    const last = chunks[chunks.length - 1];
    expect(last.endMs - last.startMs).toBeGreaterThanOrEqual(DEFAULT_CHUNK_PLAN.minTailMs);
    expect(chunks.every((c) => c.endMs - c.startMs <= DEFAULT_CHUNK_PLAN.maxMs)).toBe(true);
  });

  it("covers an hour without gaps, every chunk within bounds", () => {
    // A pause every 9 s, every third one long enough to be a turn.
    const silences = Array.from({ length: 400 }, (_, i) => ({
      startMs: i * 9_000 + 500,
      endMs: i * 9_000 + (i % 3 === 0 ? 1_500 : 900)
    }));
    const chunks = planTranscriptionChunks(3_600_000, silences);
    expect(chunks[0].startMs).toBe(0);
    expect(chunks[chunks.length - 1].endMs).toBe(3_600_000);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startMs).toBe(chunks[i - 1].endMs);
    expect(chunks.every((c) => c.endMs - c.startMs <= DEFAULT_CHUNK_PLAN.maxMs)).toBe(true);
    expect(chunks.slice(0, -1).every((c) => c.endMs - c.startMs >= DEFAULT_CHUNK_PLAN.minMs)).toBe(true);
  });
});

describe("ffmpeg log parsers", () => {
  const log = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'meeting.m4a':",
    "  Duration: 00:14:21.04, start: 0.000000, bitrate: 97 kb/s",
    "[silencedetect @ 0x1] silence_start: 3.2",
    "[silencedetect @ 0x1] silence_end: 4.1 | silence_duration: 0.9",
    "[silencedetect @ 0x1] silence_start: 860.5"
  ].join("\n");

  it("reads the duration", () => {
    expect(parseFfmpegDurationMs(log)).toBe(861_040);
    expect(parseFfmpegDurationMs("no banner")).toBeNull();
  });

  it("reads closed pauses and drops one still open at the end", () => {
    expect(parseSilences(log)).toEqual([{ startMs: 3_200, endMs: 4_100 }]);
  });
});

describe("notes prompt", () => {
  it("asks for the JSON shape with tasks, owners and the mine flag", () => {
    expect(NOTES_SYSTEM_PROMPT).toContain('"tasks": [{"task": string, "owner": string | null, "mine": boolean}]');
    expect(NOTES_SYSTEM_PROMPT).toMatch(/Never invent/u);
  });

  it("puts the transcript in the user message and names the language", () => {
    const messages = buildNotesMessages("[00:00:00] Привіт\n", "uk");
    expect(messages.user).toContain("[00:00:00] Привіт");
    expect(messages.referenceContext).toBe("");
    expect(buildNotesMessages("x", "uk").user).toMatch(/in Ukrainian\.$/u);
    expect(buildNotesMessages("x", "en").user).toMatch(/in English\.$/u);
  });

  it("resolves auto to the call's main language and keeps a forced one", () => {
    const mixed = "[00:00:00] Добрий день, обговорюємо реліз.\n[00:00:16] Sounds good.\n";
    expect(resolveNotesLanguage("auto", mixed)).toBe("uk");
    expect(resolveNotesLanguage("auto", "[00:00:00] Let's ship it.\n")).toBe("en");
    expect(resolveNotesLanguage("en", mixed)).toBe("en");
  });

  it("reads the language setting defensively", () => {
    expect(parseNotesLanguage("uk")).toBe("uk");
    expect(parseNotesLanguage("en")).toBe("en");
    expect(parseNotesLanguage("ru")).toBe("auto");
    expect(parseNotesLanguage(undefined)).toBe("auto");
  });
});

describe("parseNotes", () => {
  it("reads JSON wrapped in a fence and prose", () => {
    const notes = parseNotes(
      'Here are the notes:\n```json\n{"title":"Реліз 0.5","summary":["Обговорили реліз"],"decisions":["Реліз у п\'ятницю"],' +
        '"tasks":[{"task":"Зібрати DMG","owner":"Андрій","mine":true},{"task":"Review PR","owner":null,"mine":false}]}\n```'
    );
    expect(notes).toEqual({
      title: "Реліз 0.5",
      summary: ["Обговорили реліз"],
      decisions: ["Реліз у п'ятницю"],
      tasks: [
        { task: "Зібрати DMG", owner: "Андрій", mine: true },
        { task: "Review PR", owner: null, mine: false }
      ]
    });
  });

  it("drops malformed items instead of failing the call", () => {
    const notes = parseNotes(
      '{"title":"Sync","summary":["a", 3, " "],"tasks":[{"task":""},{"owner":"Bob"},"x",{"task":"Ship it","owner":"","mine":"yes"}]}'
    );
    expect(notes.summary).toEqual(["a"]);
    expect(notes.decisions).toEqual([]);
    expect(notes.tasks).toEqual([{ task: "Ship it", owner: null, mine: false }]);
  });

  it("throws on no JSON, broken JSON or an empty object", () => {
    expect(() => parseNotes("Sorry, I cannot help with that.")).toThrow(/not JSON/u);
    expect(() => parseNotes('{"title": "x",')).toThrow(/not JSON|not valid JSON/u);
    expect(() => parseNotes('{"title": "", "summary": []}')).toThrow(/empty/u);
  });
});

describe("transcript and notes.md", () => {
  it("timestamps every line from the start of the recording", () => {
    expect(formatTranscript([{ startMs: 0, text: " Hello " }, { startMs: 3_725_000, text: "Bye" }])).toBe(
      "[00:00:00] Hello\n[01:02:05] Bye\n"
    );
  });

  it("guesses the call language from the alphabet", () => {
    expect(transcriptLanguage("Задеплоїти на staging завтра")).toBe("uk");
    expect(transcriptLanguage("Deploy to staging tomorrow, ок")).toBe("en");
  });

  it("renders headings in the call's language and marks the user's tasks", () => {
    const md = renderNotesMarkdown(
      {
        title: "Реліз",
        summary: ["Пункт"],
        decisions: [],
        tasks: [{ task: "Зібрати DMG", owner: "Андрій", mine: true }, { task: "Тест", owner: null, mine: false }]
      },
      "uk",
      "2026-11-09T10:00:00.000Z"
    );
    expect(md).toContain("# Реліз");
    expect(md).toContain("## Підсумок\n\n- Пункт");
    expect(md).not.toContain("## Рішення");
    expect(md).toContain("- [ ] Зібрати DMG — Андрій, я");
    expect(md).toContain("- [ ] Тест\n");
    expect(md).toContain("[transcript.txt](transcript.txt)");
  });

  it("is listed with the recording once notes.json exists", () => {
    const manifest = { id: "m", state: "done", startedAt: "2026-11-09T10:00:00.000Z", audioPath: "/m/m/meeting.m4a" };
    const files = meetingNotesFiles("/m/m");
    const without = toMeetingEntry(manifest, "/m/m", (p) => (p === "/m/m/meeting.m4a" ? 1 : null), false);
    const withNotes = toMeetingEntry(manifest, "/m/m", (p) => (p === "/m/m/meeting.m4a" || p === files.notesJson ? 1 : null), false);
    expect(without?.notesPath).toBeNull();
    expect(withNotes?.notesPath).toBe(files.notesJson);
  });
});

class FakeWhisper implements WhisperBackend {
  readonly clips: string[] = [];
  constructor(private readonly answer: (index: number) => string) {}
  async transcribe(wavPath: string): Promise<TranscribeResult> {
    this.clips.push(wavPath);
    return { text: this.answer(this.clips.length - 1) };
  }
}

class FakeSummarizer implements SummaryStreamer {
  readonly id: SummaryProviderId = "claude-api";
  readonly prompts: SummaryMessages[] = [];
  constructor(private readonly answer: string) {}
  async stream(): Promise<string> {
    throw new Error("captions path not used for notes");
  }
  async streamMessages(messages: SummaryMessages): Promise<string> {
    this.prompts.push(messages);
    return this.answer;
  }
}

const NOTES_ANSWER = '{"title":"Sync","summary":["Talked"],"decisions":[],"tasks":[{"task":"Ship","owner":null,"mine":true}]}';

describe.skipIf(!MeetingAudioMixer.getBinaryPath())("MeetingNotesService", () => {
  let root: string;
  let audioPath: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), "marshal-notes-test-"));
    audioPath = path.join(root, "meeting.m4a");
    // 40 s: tone, a 1 s pause at 20 s, tone — two chunks cut inside the pause.
    execFileSync(MeetingAudioMixer.getBinaryPath()!, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=19",
      "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", "-c:a", "aac", "-y", audioPath
    ]);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function folder(name: string): Promise<string> {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  it("transcribes chunk by chunk, drops hallucinations and writes the notes", async () => {
    const dir = await folder("full");
    const whisper = new FakeWhisper((i) => (i === 0 ? "Привіт, обговоримо реліз." : "Thank you."));
    const summarizer = new FakeSummarizer(NOTES_ANSWER);
    const progress: Array<NotesProgress | null> = [];
    const service = new MeetingNotesService((p) => progress.push(p), { whisper: () => whisper, summarizer: () => summarizer });

    const result = await service.run({ id: "m1", folder: dir, audioPath, startedAt: "2026-11-09T10:00:00.000Z", language: "auto" });

    expect(result).toEqual({ ok: true });
    expect(whisper.clips).toHaveLength(2);
    const files = meetingNotesFiles(dir);
    expect(await fs.readFile(files.transcript, "utf8")).toBe("[00:00:00] Привіт, обговоримо реліз.\n");
    expect(summarizer.prompts[0].user).toContain("Привіт, обговоримо реліз.");
    const stored = JSON.parse(await fs.readFile(files.notesJson, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({ title: "Sync", language: "uk", requestedLanguage: "auto", provider: "claude-api" });
    expect(await fs.readFile(files.notesMd, "utf8")).toContain("## Задачі");
    expect(progress.some((p) => p?.phase === "transcribing" && p.total === 2)).toBe(true);
    expect(progress[progress.length - 1]).toBeNull();
    expect(service.current()).toBeNull();
  });

  it("reuses a saved transcript when the notes are regenerated", async () => {
    const dir = await folder("regen");
    await fs.writeFile(meetingNotesFiles(dir).transcript, "[00:00:00] Saved line\n", "utf8");
    const whisper = new FakeWhisper(() => "never");
    const summarizer = new FakeSummarizer(NOTES_ANSWER);
    const service = new MeetingNotesService(() => undefined, { whisper: () => whisper, summarizer: () => summarizer });

    expect(await service.run({ id: "m2", folder: dir, audioPath, startedAt: "x", language: "en" })).toEqual({ ok: true });
    expect(whisper.clips).toHaveLength(0);
    expect(summarizer.prompts[0].user).toMatch(/in English\.$/u);
  });

  it("keeps the transcript when no summary provider is configured", async () => {
    const dir = await folder("no-provider");
    const service = new MeetingNotesService(() => undefined, {
      whisper: () => new FakeWhisper(() => "Some speech here."),
      summarizer: () => null
    });
    const result = await service.run({ id: "m3", folder: dir, audioPath, startedAt: "x", language: "auto" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Transcript saved/u);
    expect(existsSync(meetingNotesFiles(dir).transcript)).toBe(true);
    expect(existsSync(meetingNotesFiles(dir).notesJson)).toBe(false);
  });

  it("runs one job at a time and cancels between chunks", async () => {
    const dir = await folder("cancel");
    let service: MeetingNotesService;
    const whisper = new FakeWhisper(() => {
      service.cancel("m4");
      return "Words.";
    });
    service = new MeetingNotesService(() => undefined, { whisper: () => whisper, summarizer: () => new FakeSummarizer(NOTES_ANSWER) });

    const running = service.run({ id: "m4", folder: dir, audioPath, startedAt: "x", language: "auto" });
    expect(await service.run({ id: "other", folder: dir, audioPath, startedAt: "x", language: "auto" })).toEqual({
      ok: false,
      error: "Another recording is being transcribed."
    });
    expect(await running).toEqual({ ok: false, cancelled: true, error: "Cancelled." });
    expect(whisper.clips).toHaveLength(1);
    expect(existsSync(meetingNotesFiles(dir).transcript)).toBe(false);
  });
});
