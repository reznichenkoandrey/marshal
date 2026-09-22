# Live captions — V2 roadmap (hands-free)

The V1 overlay (#176) shipped in 0.3.0. This page tracks the V2 spec
("Hands-Free Assistive Live-Captioning & Context Subtitles Overlay") against
what the code already does, so the remaining work is a list of issues, not a
re-read of the spec. Umbrella issue: #190. Reference stack in the spec is Python/PyQt6 + Silero VAD +
EasyOCR; as with V1 it is implemented in Marshal's Electron + Swift stack.

Legend: ✅ done · 🟡 partial · ⬜ not started.

## 2.1 Local-only privacy overlay

| Requirement | Status | Where |
|---|---|---|
| macOS: NSPanel, `sharingType = .none` | ✅ | `desktop/captions/captions-window.ts` — `type: "panel"`, `setContentProtection(true)` |
| Windows: `WS_EX_TOOLWINDOW` + `WDA_EXCLUDEFROMCAPTURE` | 🟡 | `setContentProtection` already maps to `WDA_EXCLUDEFROMCAPTURE`; audio loopback is the missing half — #178 |
| Frameless, translucent, click-through (`WS_EX_TRANSPARENT`) | ✅ | `frame: false`, `transparent: true`, `setIgnoreMouseEvents` |
| Drag mode on a held modifier | ✅ | Left Control via `ptt-monitor`, tray fallback; configurable in Settings (#179) |

## 2.2 Intelligent audio loopback & transcription

| Requirement | Status | Where / what is missing |
|---|---|---|
| System audio loopback (not the mic) | ✅ macOS | `swift/system-audio-tap.swift` (ScreenCaptureKit); Windows WASAPI — #178 |
| Continuous background VAD | 🟡 | `segmenter.ts` is an energy-based VAD with an adaptive noise floor. Works on call audio; a model VAD (Silero / WebRTC) is more robust to music, typing and cross-talk — #186 |
| Configurable silence threshold (1.2–1.5 s) | 🟡 | Fixed at 650 ms (`silenceEndMs`). Needs a Settings field and a tuning pass: 650 ms cuts mid-sentence on slow speakers, 1.5 s adds latency — #186 |
| Question-intonation end detection | ⬜ | No pitch analysis. Cheapest useful version: treat a whisper segment ending in `?` as a turn end and summarize immediately — #187 |
| Filler-word / half-sentence filtering | ⬜ | Only whisper's silence hallucinations are dropped (`isLikelyHallucination`). Fillers ("uhm", "so", "like") and fragments should not reach the summarizer — #187 |
| Trigger the AI pipeline the moment a turn ends | ✅ | Every accepted segment schedules a summary after a 600 ms debounce |

## 2.3 On-demand visual context (OCR)

| Requirement | Status | Where |
|---|---|---|
| Global hotkey `Ctrl+Shift+S` | ✅ | Configurable in Settings |
| Predefined bounding box → OCR | ✅ | Region picked once, remembered; Apple Vision (`apple-vision-ocr`) instead of EasyOCR/Tesseract |
| Overlay hidden during the capture | ✅ | `CaptionsWindow.withHidden`, plus content protection excludes it anyway |

## 2.4 Semantic processing, personalization & queue

| Requirement | Status | Where / what is missing |
|---|---|---|
| Local context grounding (reference files → system prompt) | ⬜ | Nothing yet. Planned: a folder of Markdown/text files in userData, concatenated (size-capped) into the system prompt; a Settings picker; optional embeddings later — #188 |
| V2 system prompt (first person, code snippets) | ⬜ | V1 prompt is the spec's V1 text verbatim. V2 wording only makes sense once reference context exists, otherwise "first person" is fabrication — #188 |
| Request queue: queue or interrupt an in-flight generation | 🟡 | In-flight summary is aborted and restarted with the newer transcript (`AbortController`). The "queue" option and a visible "…updating" state are missing — #189 |
| Token streaming | ✅ | OpenAI-compatible SSE or Anthropic SDK; deltas render as they arrive |
| Total response latency < 1 s | 🟡 | Measured 1.3–2.0 s from end of speech to the updated summary on Groq: ~650 ms silence wait + ~550 ms whisper + ~450 ms first token. Under 1 s needs streaming STT or a shorter silence window — #189 |

## Testing notes

- Do not use `say` to test multi-sentence audio; it restarts its output between
  sentences and ScreenCaptureKit loses everything after the first. Render a file
  (`say -o`) and play it with `afplay`, or use a real call.
- macOS zero-gates ~1 s of captured output around *digital* silence. Real audio
  has a noise floor, so calls are unaffected; test files should carry one.
- The first exec of a freshly signed Swift helper after install costs ~35 s
  (Gatekeeper). The Vision helper is warmed up at start (#181); others pay it on
  first use.
