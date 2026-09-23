// desktop/captions/captions-defaults.ts
//
// Defaults and value sets for the live captions settings. No Electron
// imports: settings-store.ts, the service and the tests all read from here.

/**
 * Whisper's initial prompt for the captions path. The dictation default is a
 * Ukrainian verbatim instruction, which is the wrong prior for an English
 * interview or webinar; this one only primes technical vocabulary and lets
 * the language be whatever comes through the speakers.
 */
export const DEFAULT_CAPTIONS_PROMPT =
  "Technical conversation: API, backend, frontend, TypeScript, React, Node.js, Python, SQL, " +
  "Docker, Kubernetes, CI/CD, latency, throughput, cache, queue, microservices, REST, GraphQL.";

/** Same family as the meeting/dictation toggles, clear of the macOS screenshot chords. */
export const DEFAULT_CAPTIONS_HOTKEY = "CommandOrControl+Alt+Shift+C";
/** The OCR hotkey from the spec. */
export const DEFAULT_CAPTIONS_OCR_HOTKEY = "Control+Shift+S";
/** Modifier held to move the overlay; goes through the Swift ptt-monitor. */
export const DEFAULT_CAPTIONS_DRAG_MODIFIER = "LeftControl";

/** Summarizer provider as chosen in Settings; `auto` picks by available credentials. */
export type CaptionsProviderChoice = "auto" | "openai-api" | "claude-api" | "off";
export const VALID_CAPTIONS_PROVIDERS: readonly CaptionsProviderChoice[] = ["auto", "openai-api", "claude-api", "off"];

/** Speech-to-text for captions; `auto` follows the dictation backend. */
export type CaptionsSttChoice = "auto" | "whisper-cpp" | "groq" | "hybrid";
export const VALID_CAPTIONS_STT: readonly CaptionsSttChoice[] = ["auto", "whisper-cpp", "groq", "hybrid"];

/** Trailing silence that closes an utterance. The spec suggests 1.2–1.5 s; 900 ms is the middle ground between cutting slow speakers and adding latency. */
export const DEFAULT_CAPTIONS_SILENCE_MS = 900;
export const MIN_CAPTIONS_SILENCE_MS = 400;
export const MAX_CAPTIONS_SILENCE_MS = 2_000;

/** Per-frame speech detector: Silero VAD (ONNX on WASM) or the adaptive energy gate. */
export type CaptionsVadChoice = "silero" | "energy";
export const VALID_CAPTIONS_VAD: readonly CaptionsVadChoice[] = ["silero", "energy"];

/** New transcript while a summary streams: restart it (fresh) or let it finish and run once more (stable). */
export type CaptionsTurnPolicy = "interrupt" | "queue";
export const VALID_CAPTIONS_TURN_POLICIES: readonly CaptionsTurnPolicy[] = ["interrupt", "queue"];
/** Trailing silence after which an utterance is transcribed speculatively, before the real cut. */
export const PROVISIONAL_SILENCE_MS = 300;
