// On-demand notes for a finished meeting recording (#271): where the files
// live, how meeting.m4a is cut for whisper, what the summarizer is asked and
// how its answer is read back. Everything here is pure so the parts that are
// easy to get subtly wrong — cut points, the prompt contract, a model answer
// wrapped in prose — are pinned by tests; meeting-notes-service.ts does the IO.
//
// Nothing runs without the click: automatic transcription stays off (#229).

import path from "node:path";

import type { SummaryMessages } from "../captions/summary-prompt.ts";

export const TRANSCRIPT_FILE = "transcript.txt";
export const NOTES_MD_FILE = "notes.md";
export const NOTES_JSON_FILE = "notes.json";

export type MeetingNotesFiles = { transcript: string; notesMd: string; notesJson: string };

export function meetingNotesFiles(folder: string): MeetingNotesFiles {
  return {
    transcript: path.join(folder, TRANSCRIPT_FILE),
    notesMd: path.join(folder, NOTES_MD_FILE),
    notesJson: path.join(folder, NOTES_JSON_FILE)
  };
}

/** Language the notes are written in; `auto` follows the call. */
export type NotesLanguage = "auto" | "uk" | "en";

export function parseNotesLanguage(raw: unknown): NotesLanguage {
  return raw === "uk" || raw === "en" ? raw : "auto";
}

// ── Chunk planning ─────────────────────────────────────────────────────────

export type Silence = { startMs: number; endMs: number };
export type TranscriptionChunk = { index: number; startMs: number; endMs: number };

export type ChunkPlanOptions = {
  /** A pause at least this long reads as a change of speaker or sentence: cut there. */
  turnPauseMs: number;
  /** No chunk is shorter than this unless the whole recording is. */
  minMs: number;
  /** A chunk never runs past this; without a turn pause it is cut at the longest pause, else hard. */
  maxMs: number;
  /** The last chunk is at least this long — a sliver of audio is where whisper invents text. */
  minTailMs: number;
};

// Cut at every turn, not at a fixed length: whisper detects the language once
// per request, and a request holding a Ukrainian and an English speaker came
// back with the English half silently dropped (measured on a mixed sample).
// Chunks stay within one 30 s whisper window, so each request is short and a
// dictation phrase never waits long behind one in the shared server.
export const DEFAULT_CHUNK_PLAN: ChunkPlanOptions = {
  turnPauseMs: 600,
  minMs: 3_000,
  maxMs: 30_000,
  minTailMs: 3_000
};

/**
 * Splits a recording into chunks for whisper, cutting in the middle of a
 * pause so no word is split across two requests.
 */
export function planTranscriptionChunks(
  durationMs: number,
  silences: readonly Silence[],
  options: ChunkPlanOptions = DEFAULT_CHUNK_PLAN
): TranscriptionChunk[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const pauses = silences
    .map((silence) => ({ midMs: (silence.startMs + silence.endMs) / 2, lengthMs: silence.endMs - silence.startMs }))
    .filter((pause) => pause.midMs > 0 && pause.midMs < durationMs)
    .sort((a, b) => a.midMs - b.midMs);

  const chunks: TranscriptionChunk[] = [];
  let start = 0;
  for (;;) {
    const earliest = start + options.minMs;
    const latest = Math.min(start + options.maxMs, durationMs - options.minTailMs);
    const inRange = pauses.filter((pause) => pause.midMs >= earliest && pause.midMs <= latest);
    const turn = inRange.find((pause) => pause.lengthMs >= options.turnPauseMs);
    let cut: number;
    if (turn) cut = turn.midMs;
    else if (durationMs - start <= options.maxMs) break;
    else if (inRange.length > 0) cut = inRange.reduce((best, pause) => (pause.lengthMs > best.lengthMs ? pause : best)).midMs;
    else cut = latest;
    cut = Math.round(cut);
    chunks.push({ index: chunks.length, startMs: start, endMs: cut });
    start = cut;
  }
  chunks.push({ index: chunks.length, startMs: start, endMs: Math.round(durationMs) });
  return chunks;
}

/** `Duration: 00:14:21.04` from ffmpeg's input banner. */
export function parseFfmpegDurationMs(stderr: string): number | null {
  const match = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/u);
  if (!match) return null;
  return Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000);
}

/**
 * Pauses from ffmpeg's `silencedetect` log. A silence still open when the
 * file ends has a start and no end; it cannot be a cut point and is dropped.
 */
export function parseSilences(stderr: string): Silence[] {
  const silences: Silence[] = [];
  let openStart: number | null = null;
  for (const match of stderr.matchAll(/silence_(start|end):\s*(-?\d+(?:\.\d+)?)/gu)) {
    const ms = Math.max(0, Math.round(Number(match[2]) * 1000));
    if (match[1] === "start") openStart = ms;
    else if (openStart !== null) {
      silences.push({ startMs: openStart, endMs: ms });
      openStart = null;
    }
  }
  return silences;
}

// ── Transcript ─────────────────────────────────────────────────────────────

export type TranscriptLine = { startMs: number; text: string };

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}

export function formatTranscript(lines: readonly TranscriptLine[]): string {
  return lines.map((line) => `[${formatTimestamp(line.startMs)}] ${line.text.trim()}`).join("\n") + "\n";
}

/**
 * Ukrainian or English, by which alphabet most letters are in — what `auto`
 * resolves to. Decided here rather than left to the model: asked to "follow
 * the call", it wrote a mostly Ukrainian call's notes in English.
 */
export function transcriptLanguage(text: string): "uk" | "en" {
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return cyrillic > latin ? "uk" : "en";
}

// ── Summary prompt and answer ──────────────────────────────────────────────

export const NOTES_MAX_TOKENS = 4096;

export const NOTES_SYSTEM_PROMPT = [
  "You write meeting notes from the transcript of a recorded call.",
  "The transcript is machine speech-to-text of the mixed call audio: speakers are not labelled and some words may be misrecognised.",
  "Use only what was said. Never invent decisions, tasks, owners or dates.",
  "A word that looks misrecognised stays as written; do not guess what it meant.",
  "Answer with exactly one JSON object and nothing else, in this shape:",
  '{"title": string, "summary": string[], "decisions": string[], "tasks": [{"task": string, "owner": string | null, "mine": boolean}]}',
  "- title: what the call was about, at most 10 words.",
  "- summary: 3-8 short points covering the main topics and outcomes.",
  "- decisions: what was agreed; an empty array when nothing was decided.",
  "- tasks: action items someone committed to or was asked to do, each phrased as an action.",
  "  owner: the person's name as said in the call, or null when unclear.",
  "  mine: true only when the task clearly belongs to the person who recorded the call; false when unsure.",
  "Keep technical terms, product names and identifiers exactly as spoken; do not translate them."
].join("\n");

const LANGUAGE_INSTRUCTION: Record<"uk" | "en", string> = {
  uk: "Write the notes in Ukrainian.",
  en: "Write the notes in English."
};

export function resolveNotesLanguage(setting: NotesLanguage, transcript: string): "uk" | "en" {
  return setting === "auto" ? transcriptLanguage(transcript) : setting;
}

export function buildNotesMessages(transcript: string, language: "uk" | "en"): SummaryMessages {
  const user = `Call transcript (timestamps are from the start of the recording):\n${transcript.trim()}\n\n${LANGUAGE_INSTRUCTION[language]}`;
  return { system: NOTES_SYSTEM_PROMPT, systemInstructions: NOTES_SYSTEM_PROMPT, referenceContext: "", user };
}

export type MeetingTask = { task: string; owner: string | null; mine: boolean };
export type MeetingNotes = { title: string; summary: string[]; decisions: string[]; tasks: MeetingTask[] };

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Reads the model's answer. Tolerates what models wrap JSON in — a code
 * fence, a sentence before or after — and drops malformed items instead of
 * failing the whole call. Throws only when there is no usable object at all.
 */
export function parseNotes(answer: string): MeetingNotes {
  const first = answer.indexOf("{");
  const last = answer.lastIndexOf("}");
  if (first === -1 || last <= first) throw new Error("The summary was not JSON.");
  let raw: unknown;
  try {
    raw = JSON.parse(answer.slice(first, last + 1));
  } catch (err) {
    throw new Error(`The summary was not valid JSON: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The summary was not a JSON object.");
  const record = raw as Record<string, unknown>;
  const tasks: MeetingTask[] = [];
  if (Array.isArray(record.tasks)) {
    for (const item of record.tasks) {
      if (!item || typeof item !== "object") continue;
      const task = item as Record<string, unknown>;
      const description = text(task.task);
      if (!description) continue;
      tasks.push({ task: description, owner: text(task.owner) || null, mine: task.mine === true });
    }
  }
  const notes: MeetingNotes = {
    title: text(record.title),
    summary: strings(record.summary),
    decisions: strings(record.decisions),
    tasks
  };
  if (!notes.title && notes.summary.length === 0) throw new Error("The summary came back empty.");
  return notes;
}

const HEADINGS = {
  uk: { summary: "Підсумок", decisions: "Рішення", tasks: "Задачі", me: "я", untitled: "Дзвінок", transcript: "Транскрипт" },
  en: { summary: "Summary", decisions: "Decisions", tasks: "Action items", me: "me", untitled: "Call", transcript: "Transcript" }
} as const;

export function renderNotesMarkdown(notes: MeetingNotes, language: "uk" | "en", startedAt: string): string {
  const h = HEADINGS[language];
  const out = [`# ${notes.title || h.untitled}`, "", `_${startedAt.slice(0, 16).replace("T", " ")} UTC_`, ""];
  const list = (heading: string, items: string[]): void => {
    if (items.length === 0) return;
    out.push(`## ${heading}`, "", ...items.map((item) => `- ${item}`), "");
  };
  list(h.summary, notes.summary);
  list(h.decisions, notes.decisions);
  if (notes.tasks.length > 0) {
    out.push(`## ${h.tasks}`, "");
    for (const task of notes.tasks) {
      const who = [task.owner, task.mine ? h.me : null].filter(Boolean).join(", ");
      out.push(`- [ ] ${task.task}${who ? ` — ${who}` : ""}`);
    }
    out.push("");
  }
  out.push(`${h.transcript}: [${TRANSCRIPT_FILE}](${TRANSCRIPT_FILE})`, "");
  return out.join("\n");
}
