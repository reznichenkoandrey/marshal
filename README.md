# Marshal

[![ci](https://github.com/reznichenkoandrey/marshal/actions/workflows/ci.yml/badge.svg)](https://github.com/reznichenkoandrey/marshal/actions/workflows/ci.yml)

Personal macOS menu-bar companion: **voice dictation** (push-to-talk → Whisper → clipboard), a **floating translator** (text + OCR via Groq / Claude), a **task-running agent** with multiple reasoning bridges, and a **Chrome extension** that drives ChatGPT / Claude / Gemini.

All three surface into one Electron tray app; dictation and translator work fully offline on Apple Silicon, the agent reuses whatever model subscription you already have.

> **Status:** personal project. Targets macOS first; Linux/Windows parity is not a goal today.

---

## Features

### Voice dictation (push-to-talk)
- Hold **right Cmd** (default), speak, release → transcript inserted at the caret, clipboard fallback, OS notification with preview.
- Backends: `whisper.cpp` (local, offline, free — runs with Metal on M-series Macs) or Groq `whisper-large-v3`.
- Language: auto-detect, or pin to Ukrainian / English.
- **The model is not shipped inside the app.** It is 1.5 GB, so it lives in
  `~/Library/Application Support/Marshal/models/` and is downloaded once, either from the
  menu bar (**Download Dictation Model…**) or by `npm run setup:dictation`. One copy is
  shared by every build and survives app updates and reinstalls; set `MARSHAL_MODELS_DIR`
  to put it elsewhere. An interrupted download resumes where it stopped.
- Works with AirPods, built-in mic, USB mics — AVAudioRecorder handles the resample.

### Floating translator
- Two panes side by side — source on the left, translation on the right — and it translates
  **while you type** (650 ms after the last keystroke; ⌘↵ fires it immediately).
- 42 languages with auto-detect and swap (`⌘⇧S`). The pair is remembered and also decides
  which way the hotkeys translate.
- Register switch: Neutral / Formal / Informal.
- **Glossary** (book icon): terms the translator must not rewrite. Either pin an exact
  rendering per target language, or add the term with no translation and it is left in the
  original language — which is what you want for identifiers and borrowed jargon. Measured
  before and after on the same sentence: *"retried with **відступом**"* → *"retried with
  **backoff**"*. Only terms that actually occur in the text are sent, so a long glossary
  costs nothing per keystroke.
- **Insert** (`⌘⇧V`) pastes the translation into the app you came from; **Copy** puts it on
  the clipboard. Insert restores your previous clipboard afterwards.
- Pin (`⌘P`) keeps the window open when it loses focus, so you can type in another app and
  translate here side by side. The window is resizable and remembers its size and place.
- **Unpinned, it still will not throw away work.** An empty window hides as soon as focus
  goes elsewhere; one with text in it stays, because a notification or an app launching is
  not a decision to discard a half-typed sentence. `Esc`, the close button and Clear are the
  explicit ways out.
- `⌘⌥T` resolves to what you must have meant: in front → hide it; open but behind something →
  raise it; hidden with text waiting → bring that back untouched; hidden and empty →
  translate the clipboard.
- Double ⌘C on any text → translation in a cursor-anchored window. Direction comes from the
  configured pair; text already in the target language is translated back the other way.
- ⌘⌥T hotkey anywhere opens the translator with your current clipboard.
- ⌘⇧2 captures a screen region, OCRs + translates it (Apple Vision locally, or a vision model).
- History of the last 20 translations, ↑/↓ recall when the input is empty. An entry is stored
  once the source text settles, so typing a sentence doesn't fill history with fragments.

### Live captions overlay

Subtitles and a two-to-three-bullet AI summary of whatever the Mac is playing —
the other side of a call, a webinar — on a floating overlay that the people you
share your screen with never see.

- **Invisible to screen sharing.** The overlay window has content protection on
  (`NSWindow.sharingType = .none`), so Zoom, Meet, OBS and QuickTime capture the
  wallpaper where it sits. It is also click-through: every click lands on the
  app underneath and focus never moves.
- **System audio, not the microphone.** A ScreenCaptureKit tap streams what the
  speakers play into the same whisper backend dictation uses (Groq with local
  whisper.cpp fallback). Silero VAD (ONNX on WASM, no native code) decides which
  frames are speech and a configurable pause (default 900 ms) cuts the utterance, so a
  sentence is transcribed the moment it ends and typing or music does not
  produce phantom captions.
  Fillers ("um", "you know", "ну", "типу") are stripped, half-sentences wait for
  their other half, and a question triggers the summary immediately with the
  model told to answer it.
  Utterances are transcribed speculatively at a 300 ms pause so the text is
  ready the moment the sentence ends; new speech during a streaming summary
  either restarts it or queues one follow-up (Settings), with the stale
  bullets marked "updating…" meanwhile.
- **Your own answers too, if you want.** Settings → "Also caption my microphone"
  mixes the dictation microphone into the stream (macOS 15+, headphones
  recommended: on speakers the mic hears the other side as well).
- **Screen context on demand.** `⌃⇧S` OCRs a screen region (first press picks
  the region, later presses are silent) with Apple Vision and hands the text to
  the summarizer as context. The overlay hides itself during the capture.
- **Streamed summary.** Transcript + context go to an OpenAI-compatible model
  (Groq by default, Ollama works with a local base) or the Anthropic API with a
  strict "accessibility summarizer" prompt; tokens render as they arrive. With
  no provider configured the overlay still shows raw captions. Drop your CV or
  project notes into Settings → Live captions → Reference files and the bullets
  answer as you, from your experience (the V2 first-person prompt).
- **Move it by holding Left Control**, or via tray → Live Captions → Move
  Overlay. Position is remembered.

Needs Screen Recording (same grant as screen capture). `⌘⌥⇧C` toggles it; the
tray has the same entry. Everything is configurable in Settings → Live captions;
the matching `MARSHAL_CAPTIONS_*` env vars in [`.env.example`](.env.example) are
the fallback for whatever Settings leaves blank.
What the hands-free V2 spec still needs is tracked in
[`docs/LIVE_CAPTIONS_V2.md`](docs/LIVE_CAPTIONS_V2.md) (epic #190).

### Screen capture
- The annotation editor **stays above other windows** by default, and the arrow button in its
  status bar turns that off when you need to read from the window underneath. It is on by
  default for a reason: Marshal is a menu-bar app with no Dock icon, so a normal window that
  slips behind another one has no OS affordance left to raise it.
- Turned it off and lost the window? Menu bar → **Bring Capture Editor to Front**.

### Task-running agent
- Sessions with shell + filesystem + Playwright browser tools (strictly sandboxed).
- Reasoning bridges: `claude-cli` (subscription, default), `codex-cli`, Anthropic API, OpenAI-compatible (Groq/OpenRouter), Claude web, ChatGPT web, Chrome extension.
- Swap bridge + model from the Settings modal — backend restarts itself.

### Chrome extension (separate bundle)
- Side panel for ChatGPT, Claude, Gemini.
- Local HTTP bridge so `extension` mode of the agent can drive ChatGPT from your logged-in browser without API keys.

---

## Requirements

- macOS 12+ (tested on Apple Silicon; Intel may work but isn't tested).
- Node.js ≥ 22.
- For dictation: `cmake` (via `brew install cmake`) — only needed to build `whisper.cpp` once.
- For agent `claude-cli` mode: Claude Code CLI installed + `claude auth` (Pro/Max subscription).
- For agent `codex-cli` mode: Codex CLI installed + `codex login` (ChatGPT Plus/Pro).
- For agent/translator `api` mode: Groq / OpenRouter / OpenAI API key.

---

## Installation

```bash
git clone https://github.com/reznichenkoandrey/marshal.git
cd marshal
npm install
cp .env.example .env  # edit the few keys you actually use
npm run setup:dictation  # one-time: clones whisper.cpp, builds whisper-cli, downloads the model
                         # (ggml-large-v3-turbo, 1.5 GB) into
                         # ~/Library/Application Support/Marshal/models/ — not into the repo.
                         # WHISPER_MODEL=ggml-small trades accuracy for a 465 MB download.
npm run desktop
```

### First-run macOS permissions

`npm run build` automatically patches the dev Electron.app Info.plist (adds `NSMicrophoneUsageDescription` + `NSScreenCaptureUsageDescription`) and ad-hoc re-signs the bundle. On first launch macOS will prompt:

1. **Microphone** — required for voice dictation. Click **Allow**.
2. **Accessibility** — required for push-to-talk and translator hotkeys (uiohook-napi + global shortcuts). System Settings → Privacy & Security → Accessibility → enable **Electron**.
3. **Screen Recording** — required only for the translator's OCR screen-capture feature. System Settings → Privacy & Security → Screen Recording → enable **Electron**.

Packaged builds (`npm run desktop:pack`) carry the same keys via `package.json → build.mac.extendInfo` and survive notarisation; the manual patch is dev-only.

### Installing a build on your own machine

```bash
npm run desktop:dist     # build the DMG
npm run install:local    # install it and drop the Gatekeeper flag
```

Builds are signed with a self-signed identity and are **not notarized**, so macOS attaches
`com.apple.quarantine` to the image and blocks the first launch with "Apple could not
verify…". `install:local` quits a running Marshal, copies the app out of the image into
`/Applications`, removes that attribute and verifies the signature — after it the app opens
normally, with no right-click → Open dance, on every future build.

Removing notarization from the equation entirely needs a `Developer ID Application`
certificate, which only comes with a paid Apple Developer Program membership. Anyone
downloading the DMG from Releases still sees the dialog once and clears it with
right-click → **Open**.

### Giving the installed app your API key

A packaged build resolves the project-root `.env` to a path *inside* `Marshal.app`, which does
not exist — so the installed app reads a second `.env` from its own config directory. Electron
names that directory after the package's `productName`, falling back to `name`, **not** after
the bundle name — so on the current build it is:

```
~/Library/Application Support/local-chatgpt-agent/.env
```

Don't hardcode that path: `npm run setup:env` derives it the same way Electron does, and
Settings → Setup health prints whatever the running app actually resolved.

```bash
npm run setup:env            # copy the project .env there
npm run setup:env -- --force # overwrite an existing one
```

This matters for speed, not just for cloud features. With no `MARSHAL_API_KEY` the translator
falls back to a CLI backend at roughly **ten seconds** per translation, and translating while
you type turns into lag. With the key present it uses Groq and answers in well under a second.
Settings → Setup health names the exact path when the key is missing.

### Installing the dictation model on a packaged build

The DMG deliberately does not contain the model. After installing Marshal, open the menu-bar
icon → **Download Dictation Model…**, confirm the size, and watch the percentage in the tray
tooltip. Everything else works before the model lands; only local transcription waits for it.
Settings → Setup health shows **Local Whisper** as `error` until then, with the remedy inline.

---

## Usage

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| **Right Cmd (hold)** | Dictation — hold, speak, release → insert transcript at the caret |
| **⌘⌥T** | Translate current clipboard text |
| **⌘⇧2** | Capture screen region → OCR + translate |
| **double ⌘C** within 600 ms | Auto-translate just-copied text |
| **⌘⌥L** | Layout switch — fix text typed on the wrong keyboard layout (Punto-Switcher-style, UKR ↔ ENG) |
| **⌘⌥⇧C** | Live captions overlay on/off (system audio → subtitles + AI summary) |
| **⌃⇧S** | Live captions: OCR a screen region into the summary context (first press picks the region) |
| **Left Control (hold)** | Live captions: move the overlay — it is click-through otherwise |

All shortcuts configurable via `.env` (`MARSHAL_DICTATION_HOTKEY`, etc.) or the Settings modal.

### Settings modal

Click the ⚙ icon in the main window. Fields:

- **Reasoning provider** — bridge mode + model for the agent.
- **Voice dictation** — enabled toggle, hotkey, backend (whisper.cpp / Groq), spoken language, auto-paste.
- **Live captions** — toggle and OCR hotkeys, drag modifier, summary provider / model / language, transcription backend, speech detection (Silero VAD / energy), end-of-utterance silence, spoken language, whisper prompt. Hotkeys rebind on save; the rest applies on the next captions start.

Saving restarts the agent backend utility process; dictation rebinds hotkeys in-place.

---

## Configuration (`.env`)

The full list lives in [`.env.example`](.env.example). The most common knobs:

```bash
# Agent reasoning bridge
MARSHAL_BRIDGE_MODE=claude-cli             # claude-cli | codex-cli | api | claude | claude-web | playwright | extension

# Claude Code CLI
MARSHAL_CLAUDE_BIN=claude
MARSHAL_CLAUDE_MODEL=sonnet

# Groq / OpenAI-compatible API (translator + optional agent bridge + optional Groq whisper)
MARSHAL_API_KEY=
MARSHAL_API_BASE=https://api.groq.com/openai/v1
MARSHAL_MODEL=openai/gpt-oss-120b    # agent bridge; list /models first, line-ups change
MARSHAL_VISION_MODEL=llama-3.2-11b-vision-preview

# Translator knobs
MARSHAL_TRANSLATOR_MODEL=            # text model for the translator only; falls back to MARSHAL_MODEL
                                     # default: qwen/qwen3.8-27b (measured 127-559 ms per sentence)
MARSHAL_TRANSLATOR_TEMPERATURE=0.1
MARSHAL_TRANSLATOR_MAX_TOKENS=4096
MARSHAL_TRANSLATOR_MAX_RETRIES=3

# Dictation
MARSHAL_DICTATION_ENABLED=1
MARSHAL_DICTATION_HOTKEY=RightCmd
MARSHAL_DICTATION_BACKEND=whisper-cpp     # whisper-cpp | groq
MARSHAL_DICTATION_LANGUAGE=auto           # auto | uk | en
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Electron main process                    │
│                                                              │
│  desktop/main.ts                                             │
│   ├─ DesktopBackendClient ────────▶ utilityProcess           │
│   │                                    └─ desktop/backend.ts │
│   │                                        └─ agent/runtime  │
│   │                                            └─ bridge/*   │
│   ├─ TranslatorService  (Groq API)                           │
│   ├─ TranslatorWindow (floating)                             │
│   ├─ ScreenshotService + crop overlay                        │
│   ├─ ClipboardMonitor (double ⌘C via Swift pasteboard watch) │
│   └─ DictationService                                        │
│       ├─ PushToTalkHotkey (uiohook-napi)                     │
│       ├─ Swift audio-recorder child → WAV in /tmp            │
│       └─ WhisperBackend (whisper.cpp | Groq)                 │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  chrome-extension/    (separate Manifest V3 bundle)          │
│   ├─ background service worker  ◀── HTTP bridge to agent     │
│   ├─ content scripts (ChatGPT/Claude/Gemini DOM drivers)     │
│   ├─ side panel UI                                           │
│   ├─ picker (pick-and-quote any element)                     │
│   └─ injector / page-capture / action-executor               │
└──────────────────────────────────────────────────────────────┘
```

Swift helpers (`pasteboard-watcher`, `audio-recorder`) are tiny single-purpose binaries compiled by `scripts/postbuild.mjs`. They run as children of Electron so macOS TCC checks succeed against the patched bundle.

---

## Development

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest run — 65+ unit tests
npm run test:watch    # interactive
npm run check         # typecheck + tests (pre-commit)
npm run build         # tsc + postbuild.mjs (Swift + plist patch)
npm run desktop       # build + launch
npm run desktop:dev   # same, with ELECTRON_ENABLE_LOGGING=1
npm run desktop:pack  # electron-builder --dir
```

### Repository layout

```
agent/          reasoning bridges, one-shot executor, tool sandbox (shell / fs / browser)
  bridge/      ClaudeCli, CodexCli, ClaudeApi, OpenAiApi, ClaudeWeb, Playwright, Extension
  core/        one-shot-executor, protocol
  tools/       fs, shell, browser (Playwright wrapper)
  memory/      session-local working memory
desktop/        Electron app
  main.ts
  preload.cts
  backend.ts    utility-process host for the agent
  renderer/     index.html, app.js, translator.html, translator.js, crop-overlay.html
  translator/   service, languages, window, insert, screenshot, clipboard monitor,
                backends/ (claude-cli, codex-cli, claude-api, openai-api, apple-vision),
                pasteboard-watcher.swift, send-keystroke.swift
  dictation/    service, hotkey-manager, whisper-backend, audio-recorder.swift
  settings-store.ts
chrome-extension/
  src/          background, content, sidepanel, picker, injector, agent helpers
  manifest.json
operator/       web dashboard surface used by some agent flows
scripts/        install-whisper-cpp.sh, patch-electron-info-plist.sh, postbuild.mjs
tests/          vitest suites (settings, translator, history, whisper, hotkey)
```

### Issue-first rule

Any bug, code smell, security concern, architectural observation, or feature idea becomes a GitHub issue *before* the fix lands. Don't let things get lost in comments or memory. Labels: `priority:*`, `area:*`, `type:*`. See [CLAUDE.md](CLAUDE.md) for the full house rules.

---

## Troubleshooting

### Dictation

| Symptom | Likely cause | Fix |
|---|---|---|
| Tray shows `●` but clipboard empty | mic permission denied | System Settings → Microphone → enable Electron; re-run `npm run build` if prompt never appears |
| Engine error `-10868` on AirPods | known AVAudioEngine/BT quirk | fixed in [2d6c277](https://github.com/reznichenkoandrey/marshal/commit/2d6c277) — rebuild |
| Transcript empty on short clips | whisper auto-detect flipped languages | Settings → Voice dictation → Spoken language: pin to `uk` or `en` |
| keyup never fires | uiohook + modifier-only on macOS | 60 s safety timer force-stops; re-verify Accessibility permission |

Debug logs:
```bash
MARSHAL_DICTATION_DEBUG=1 npm run desktop
```
Traces every hotkey event, recorder lifecycle, WAV size, transcription length.

### Live captions

| Symptom | Cause / fix |
|---|---|
| "system-audio-tap did not become ready" | Screen Recording is not granted to this build. System Settings → Privacy & Security → Screen Recording → enable Marshal, restart. After a self-signed rebuild the grant can be stale — toggle it off and on |
| Overlay shows captions but no bullets, hint says "captions only" | No summarizer credentials. Set `MARSHAL_API_KEY` (Groq) or `ANTHROPIC_API_KEY`, or point `MARSHAL_CAPTIONS_API_BASE` at a local Ollama |
| Captions lag 3–5 s behind speech | Local whisper.cpp path. Set `MARSHAL_API_KEY` so `hybrid` uses Groq, or a smaller `MARSHAL_WHISPER_MODEL` |
| "Thank you." / "[BLANK_AUDIO]" style lines | Whisper on near-silence. Known fillers are dropped (`isLikelyHallucination`); add new ones to `desktop/captions/transcript-buffer.ts` |
| Holding Left Control does not make the overlay draggable | The `ptt-monitor` helper needs Accessibility; use tray → Live Captions → Move Overlay, or set `MARSHAL_CAPTIONS_DRAG_MODIFIER` to another modifier |
| The overlay is visible in a screen share | Only content-protected windows are excluded; a screenshot tool that reads the frame buffer directly (rare) can still see it. `desktopCapturer` in Electron itself respects the flag |

### Translator

| Symptom | Fix |
|---|---|
| "MARSHAL_API_KEY is not set" | fill it in `.env` — and for an **installed** build run `npm run setup:env`, because the project `.env` is unreachable from inside the .app |
| Translation takes ~10 s per sentence | the translator is on a CLI backend. Either `MARSHAL_API_KEY` is missing (add a Groq key, `npm run setup:env`) or the API backend was dropped — the translator window says which, and why |
| "has no model X" in the translator | provider line-ups change and `MARSHAL_MODEL` outlived its model. List what your account serves and pick one: `curl -s -H "Authorization: Bearer $MARSHAL_API_KEY" https://api.groq.com/openai/v1/models \| jq -r '.data[].id'`, then set `MARSHAL_TRANSLATOR_MODEL` |
| 429 / rate-limit | built-in retry with exponential backoff; try again or lower `MARSHAL_TRANSLATOR_MAX_TOKENS` |
| OCR result is garbage | rate-limited or vision model picked wrong text; retry with a tighter crop |
| "Apple could not verify Marshal…" on first launch | expected — the build is not notarized. `npm run install:local` for your own builds, or right-click → **Open** once for a downloaded DMG |
| **Insert** says it could not paste | the translation stays on the clipboard — grant Accessibility to Electron (System Settings → Privacy & Security → Accessibility) and retry |
| Window keeps hiding while you type elsewhere | it is unpinned — click the pin in the header or press `⌘P` |
| Swap button is greyed out | the source is on *Detect language* and nothing has been detected yet — translate once, or pick a source language explicitly |

---

## License

MIT — see [LICENSE](LICENSE).

## Credits

- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — local transcription engine
- [uiohook-napi](https://github.com/SnosMe/uiohook-napi) — global hotkey hook
- Electron, Playwright, Groq, Anthropic, OpenAI — the usual suspects
