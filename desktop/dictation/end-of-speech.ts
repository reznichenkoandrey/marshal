// When an open-mic answer is over (#375). After Marshal asks a question the
// mic opens without a key, so something has to close it: a pause after
// speech, or nobody speaking at all. Pure, fed with the recorder's meter.

export type EndOfSpeechOptions = {
  /** dBFS at or above which a meter reading counts as speech. */
  speechDb: number;
  /** Silence after speech that ends the answer. */
  silenceMs: number;
  /** No speech by then: nobody answers. */
  noSpeechMs: number;
  /** Shorter bursts are a click or a cough, not an answer. */
  minSpeechMs: number;
  /** Hard cap on one answer. */
  maxMs: number;
};

export type EndOfSpeechVerdict = "answered" | "silent" | null;

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name]?.trim() ? value : fallback;
}

// ponytail: fixed dB threshold, calibrated on a MacBook mic in a quiet room; tune via env, adaptive noise floor if rooms vary.
export function endOfSpeechOptions(): EndOfSpeechOptions {
  return {
    speechDb: envNumber("MARSHAL_ANSWER_SPEECH_DB", -38),
    silenceMs: envNumber("MARSHAL_ANSWER_SILENCE_MS", 900),
    noSpeechMs: envNumber("MARSHAL_ANSWER_WAIT_MS", 6000),
    minSpeechMs: 250,
    maxMs: 20_000
  };
}

export class EndOfSpeech {
  private startedAt: number | null = null;
  private speechMs = 0;
  private lastAt: number | null = null;
  private lastSpeechAt: number | null = null;

  constructor(private readonly options: EndOfSpeechOptions) {}

  /** One meter reading; returns a verdict once the answer is over. */
  feed(db: number, atMs: number): EndOfSpeechVerdict {
    this.startedAt ??= atMs;
    const step = this.lastAt === null ? 0 : atMs - this.lastAt;
    this.lastAt = atMs;
    if (db >= this.options.speechDb) {
      this.speechMs += step;
      this.lastSpeechAt = atMs;
    }
    const heard = this.speechMs >= this.options.minSpeechMs;
    if (atMs - this.startedAt >= this.options.maxMs) return heard ? "answered" : "silent";
    if (heard && this.lastSpeechAt !== null && atMs - this.lastSpeechAt >= this.options.silenceMs) return "answered";
    if (!heard && atMs - this.startedAt >= this.options.noSpeechMs) return "silent";
    return null;
  }
}

/** `level -23.4` lines from `audio-recorder --meter`; anything else is null. */
export function parseMeterLine(line: string): number | null {
  const match = /^level (-?\d+(?:\.\d+)?)$/.exec(line.trim());
  return match ? Number(match[1]) : null;
}

export type OpenMicState = { asleep: boolean; meeting: boolean; captions: boolean; onCall: () => Promise<boolean> };

/**
 * Whether Marshal may decide on its own when the mic closes (#375, #384):
 * not asleep, not while a meeting recording or captions run, not on a call
 * in another app (checked last: it runs a helper).
 */
export async function openMicAllowed(state: OpenMicState): Promise<boolean> {
  if (state.asleep || state.meeting || state.captions) return false;
  return !(await state.onCall());
}
