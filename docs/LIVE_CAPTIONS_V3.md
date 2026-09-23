# Live captions — V3 roadmap (notetaking & translation)

V3 ("Hands-Free Real-Time Notetaking & Translation Engine") refactors the captions pipeline
from [V2](LIVE_CAPTIONS_V2.md) into three things only: **captions** of what the other side
says, a **live Ukrainian translation** of them, and a **scribe summary** of the decisions and
action items. This page maps the spec onto the code so the remaining work is a list of
issues, not a re-read of the spec.

## Scope

In scope: transcription, translation, summarisation, the context files that help all three
spell names and terms correctly, and the packaging bugs found on the way.

**Out of scope, by the spec's own wording:** "predictive prompt answers, question-cheating
generation, or code-solving injection patterns". The V2 modes that did this — a first-person
prompt fed by the user's CV, and "make the bullet points the answer" when a question was
heard — were **removed in #211**, not hidden behind a flag. Do not reintroduce them; the
`scribe-only scope` tests in `tests/captions-summary.test.ts` fail if a prompt branch asks the
model to answer or to speak as the user.

## Stack mapping

As with V1 and V2, the spec is written against Python. It is implemented in Marshal's
Electron + Swift stack; these are the substitutions and why.

| Spec | Marshal | Why |
|---|---|---|
| `faster-whisper` (int8 / float16) | whisper.cpp with `ggml-large-v3-turbo`, model kept resident in `whisper-server` (#218) | Same model family, already installed with dictation (`~/Library/Application Support/Marshal/models/`, #151), and on Apple Silicon it runs on the GPU. Measured on an M3 Pro: faster-whisper int8 on the CPU 3.6 s per utterance (Python prototype), whisper-cli 1.6 s, the resident server 0.6–0.7 s |
| CoreAudio virtual device routing | ScreenCaptureKit (`swift/system-audio-tap.swift`) | No virtual device for the user to install; per-app capture with the OS permission prompt |
| WASAPI loopback (Windows) | — | #178, deferred: macOS first |
| Silero VAD on 30 ms blocks | Silero VAD v5 on 32 ms windows | 512 samples at 16 kHz is the only window size the v5 model accepts (`silero-vad.ts`) |
| `asyncio.Queue` | ordered queues in `captions-service.ts` | Same contract: nothing overlaps on screen, a newer turn supersedes an older one |
| `sys._MEIPASS` / `sys.executable` (#206) | `app.getPath("userData")` passed into the backend | The PyInstaller idiom has no Electron equivalent; the packaged app's data belongs in userData |

Legend: ✅ done · 🟡 partial · ⬜ not started.

## 2.1 Audio loopback & transcription without rate limits

| Requirement | Status | Where / issue |
|---|---|---|
| System-output loopback, not the mic | ✅ macOS | `swift/system-audio-tap.swift`; Windows — #178 |
| Local STT, no cloud endpoints | ✅ | #208 — captions default to the local model whenever one is installed (`stt-choice.ts`); cloud STT only when chosen explicitly in Settings. Kept resident by #218: ~0.7 s per utterance on an M3 Pro |
| Live line that does not burn a rate limit | ✅ | #207 — each partial pass sends only the last 3 s of the open utterance (`partialWindowMs`), so its cost is constant instead of growing with the sentence; one pass per 1.5 s of speech; after a 429 the pause follows the provider's "try again in", and the full error (with the limit's name) is logged |

## 2.2 Hands-free VAD & end-of-utterance

| Requirement | Status | Where / issue |
|---|---|---|
| Continuous listening, no hotkey per utterance | ✅ | one toggle (`⌘⌥⇧C`) starts the pipeline; segmentation is automatic |
| Silero VAD, local | ✅ | `silero-vad.ts` (#186); classifier floor fixed in #202 |
| Silence threshold 1.1–1.4 s, configurable | 🟡 | configurable 400–2000 ms; default is 900 — #209 moves it to 1200 now that the live line (#203) covers the wait |
| Filler removal | ✅ | `transcript-normalize.ts` → `stripFillers` (EN/UK, #187) |
| Mid-speech self-correction keeps the latest wording | ⬜ | #209 |
| Sentence split at a thinking pause is rejoined | ✅ | `transcript-buffer.ts` continuation merge (#202) |

## 2.3 Live Ukrainian translation & queue

| Requirement | Status | Where / issue |
|---|---|---|
| Transcribed lines go through Marshal's translator | ⬜ | #210 — reuses `TranslatorService`, its backend choice and glossary |
| No overlapping text when translations arrive out of order | ⬜ | #210 — ordered by line number, not by response order |

## 2.4 Real-time scribe summarization (Claude)

| Requirement | Status | Where / issue |
|---|---|---|
| Scribe system prompt, verbatim | ✅ | `summary-prompt.ts` → `SUMMARY_SYSTEM_PROMPT` (#211) |
| Context files (agendas, project logs) guide terminology | ✅ | `context-store.ts`; framed as background that never adds facts (#211) |
| Claude with `stream=True` | ✅ | `summarizer.ts` → `AnthropicSummaryStreamer`; `auto` prefers Claude when `ANTHROPIC_API_KEY` is set (#211). Model: `claude-haiku-4-5`, override `MARSHAL_CAPTIONS_CLAUDE_MODEL` |
| Keep summarising when the Claude account cannot serve | ✅ | `FallbackSummaryStreamer` (#214): under `auto`, a rejected key, an empty credit balance or a missing model switches to the OpenAI-compatible provider for the rest of the session and says so in the overlay hint. Rate limits and 5xx do not switch; an explicitly chosen provider is never wrapped |
| < 1 s from end of speech to first tokens | 🟡 | measured +102 ms on the Groq path (#189); **not yet measured on Claude** — needs a run with the user's key |

## 2.5 Build debugging

| Requirement | Status | Where / issue |
|---|---|---|
| Packaged app finds its project data | ⬜ | #206 — `operator-data` resolved against `cwd`, which is `/` for an app launched from Finder |
| Microphone mix without clipping | ⬜ | #212 — hard clip on overlap; possible mic stall while system audio is silent |

## Configuration (all in `~/Library/Application Support/Marshal/.env`, restart after editing)

| Variable | Default | Meaning |
|---|---|---|
| `MARSHAL_CAPTIONS_PROVIDER` | `auto` | `claude-api`, `openai-api`, `off`; `auto` prefers Claude and falls back to `openai-api` if Claude is unusable (#214) |
| `MARSHAL_CAPTIONS_CLAUDE_MODEL` | `claude-haiku-4-5` | summary model on the Anthropic path |
| `MARSHAL_CAPTIONS_STT_BACKEND` | local if a model is installed, else follows dictation | `whisper-cpp` (local), `groq`, `hybrid` (#208) |
| `MARSHAL_CAPTIONS_PARTIALS` | on | `0` turns the live line off (#203); locally it runs only through the resident server (#208) |
| `MARSHAL_CAPTIONS_PARTIAL_MS` | `1500` | speech between live-line updates (#207) |
| `MARSHAL_CAPTIONS_MIN_RMS` | `120` | classifier energy floor (#202) |
| `MARSHAL_CAPTIONS_SILENCE_MS` | `900` | end-of-utterance pause — #209 |
| `MARSHAL_CAPTIONS_MIX_MIC` | `0` | also caption the microphone (#191, #212) |
