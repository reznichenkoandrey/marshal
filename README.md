# Marshal

[![ci](https://github.com/reznichenkoandrey/marshal/actions/workflows/ci.yml/badge.svg)](https://github.com/reznichenkoandrey/marshal/actions/workflows/ci.yml)

Personal macOS menu-bar companion: **voice dictation** (push-to-talk → Whisper → clipboard), a **floating translator** (text + OCR via Groq / Claude), a **task-running agent** with multiple reasoning bridges, and a **Chrome extension** that drives ChatGPT / Claude / Gemini.

All three surface into one Electron tray app; dictation and translator work fully offline on Apple Silicon, the agent reuses whatever model subscription you already have.

> **Status:** personal project. Targets macOS first; Linux/Windows parity is not a goal today.

---

## Features

### Voice dictation (push-to-talk)
- Hold **right Cmd** (default), speak, release → transcript in clipboard, OS notification with preview.
- Backends: `whisper.cpp` (local, offline, free — runs with Metal on M-series Macs) or Groq `whisper-large-v3`.
- Language: auto-detect, or pin to Ukrainian / English.
- Works with AirPods, built-in mic, USB mics — AVAudioRecorder handles the resample.

### Floating translator
- Double ⌘C on any text → auto-detected translation (uk ↔ en) in a cursor-anchored window.
- ⌘⌥T hotkey anywhere opens the translator with your current clipboard.
- ⌘⇧2 captures a screen region, OCRs + translates it (Groq vision model).
- History of the last 20 translations, ↑/↓ recall when the input is empty.

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
npm run setup:dictation  # one-time: clones whisper.cpp, builds whisper-cli, downloads ggml-small (~465 MB)
npm run desktop
```

### First-run macOS permissions

`npm run build` automatically patches the dev Electron.app Info.plist (adds `NSMicrophoneUsageDescription` + `NSScreenCaptureUsageDescription`) and ad-hoc re-signs the bundle. On first launch macOS will prompt:

1. **Microphone** — required for voice dictation. Click **Allow**.
2. **Accessibility** — required for push-to-talk and translator hotkeys (uiohook-napi + global shortcuts). System Settings → Privacy & Security → Accessibility → enable **Electron**.
3. **Screen Recording** — required only for the translator's OCR screen-capture feature. System Settings → Privacy & Security → Screen Recording → enable **Electron**.

Packaged builds (`npm run desktop:pack`) carry the same keys via `package.json → build.mac.extendInfo` and survive notarisation; the manual patch is dev-only.

---

## Usage

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| **Right Cmd (hold)** | Dictation — hold, speak, release → transcript in clipboard |
| **⌘⌥T** | Translate current clipboard text |
| **⌘⇧2** | Capture screen region → OCR + translate |
| **double ⌘C** within 600 ms | Auto-translate just-copied text |
| **⌘⌥L** | Layout switch — fix text typed on the wrong keyboard layout (Punto-Switcher-style, UKR ↔ ENG) |

All shortcuts configurable via `.env` (`MARSHAL_DICTATION_HOTKEY`, etc.) or the Settings modal.

### Settings modal

Click the ⚙ icon in the main window. Fields:

- **Reasoning provider** — bridge mode + model for the agent.
- **Voice dictation** — enabled toggle, hotkey, backend (whisper.cpp / Groq), spoken language, auto-paste.

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
MARSHAL_MODEL=llama-3.3-70b-versatile
MARSHAL_VISION_MODEL=llama-3.2-11b-vision-preview

# Translator knobs
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
  translator/   service, window, screenshot, clipboard monitor, pasteboard-watcher.swift
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

### Translator

| Symptom | Fix |
|---|---|
| "MARSHAL_API_KEY is not set" | fill it in `.env` |
| 429 / rate-limit | built-in retry with exponential backoff; try again or lower `MARSHAL_TRANSLATOR_MAX_TOKENS` |
| OCR result is garbage | rate-limited or vision model picked wrong text; retry with a tighter crop |

---

## License

MIT — see [LICENSE](LICENSE) (to be added).

## Credits

- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — local transcription engine
- [uiohook-napi](https://github.com/SnosMe/uiohook-napi) — global hotkey hook
- Electron, Playwright, Groq, Anthropic, OpenAI — the usual suspects
