// Where a voice command's time goes (#448): MARSHAL_ASSISTANT_DEBUG=1 logs one
// line per stage, from the key-up to the first sound of the answer.

export const VOICE_STAGES = ["key-up", "transcript", "sent", "answer", "audio"] as const;
export type VoiceStage = (typeof VOICE_STAGES)[number];

// A key-up this old belonged to a dictation, not to the command now transcribed.
const STALE_KEY_UP_MS = 30_000;

export class VoiceTimeline {
  private readonly marks = new Map<VoiceStage, number>();

  constructor(
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  mark(stage: VoiceStage): void {
    const at = this.now();
    if (stage === "key-up") this.marks.clear();
    if (stage === "transcript") {
      // Each command starts over; only a fresh key-up not used by an earlier command is its own.
      const keyUp = this.marks.get("key-up");
      const ownKeyUp = keyUp !== undefined && at - keyUp <= STALE_KEY_UP_MS && !this.marks.has("transcript");
      this.marks.clear();
      if (ownKeyUp) this.marks.set("key-up", keyUp);
    }
    // Only the first answer and the first sound after a command: later phrases are not its latency.
    if (this.marks.has(stage)) return;
    const index = VOICE_STAGES.indexOf(stage);
    const before = VOICE_STAGES.slice(0, index).reverse().find((earlier) => this.marks.has(earlier));
    this.marks.set(stage, at);
    if (!before) return;
    const seconds = (from: number): string => `${((at - from) / 1000).toFixed(2)}s`;
    const first = VOICE_STAGES.find((earlier) => this.marks.has(earlier))!;
    const total = stage === "audio" && first !== before ? `, ${first}→audio ${seconds(this.marks.get(first)!)}` : "";
    this.log(`[assistant-timing] ${before}→${stage} ${seconds(this.marks.get(before)!)}${total}`);
  }
}

const timeline = process.env.MARSHAL_ASSISTANT_DEBUG === "1" ? new VoiceTimeline((line) => console.log(line)) : null;

export function markVoice(stage: VoiceStage): void {
  timeline?.mark(stage);
}
