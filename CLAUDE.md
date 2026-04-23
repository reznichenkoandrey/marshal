# CLAUDE.md — Marshal Project

## Правила (ОБОВ'ЯЗКОВІ)

### Issue-first rule
**Будь-яка знайдена проблема, баг, code smell, ідея для розвитку, architectural observation, security issue або TODO — ОДРАЗУ фіксується як GitHub issue.** Не тримати в голові, не залишати в коментарях коду, не відкладати на "потім".

- Репозиторій: `reznichenkoandrey/marshal`
- Команда: `gh issue create --title "..." --body "..." --label "..."`
- Якщо знайдено під час ревью/імплементації — створити issue **перш ніж** писати фікс
- У тілі issue вказувати: `file_path:line_number`, опис проблеми, пропоноване рішення
- Багато дрібних issues > один великий — легше трекати прогрес

### Labels у проєкті
- Priority: `priority:critical`, `priority:high`, `priority:medium`, `priority:low`
- Area: `area:translator`, `area:dictation`, `area:desktop`, `area:agent`, `area:bridge`, `area:chrome-extension`
- Type: `type:security`, `type:bug`, `type:feature`, `type:refactor`, `type:tech-debt`, `type:epic`

### Commit → PR → issue linking
- Кожен комміт, що закриває issue: `fix: ... (#NN)` або `feat: ... (#NN)`
- У PR description: `Closes #NN` для автозакриття

### Tests
- Runner: **vitest** (`npm test`, `npm run test:watch`)
- Тести живуть у `tests/` на рівні проєкту
- Нові pure helpers мають бути `export`-нуті з testable форми (не внутрішні методи)
- Перед коммітом: `npm run check` (typecheck + test)

### First-run setup
- Voice dictation:
  1. `npm run setup:dictation` (whisper.cpp + `ggml-small`, ~465 MB, у `.whisper/`)
  2. **macOS permissions для `npm run desktop` (dev mode):**
     - `npm run build` автоматично патчить `node_modules/electron/dist/Electron.app/Contents/Info.plist` (додає `NSMicrophoneUsageDescription` + `NSScreenCaptureUsageDescription`) та ad-hoc re-signsить bundle — інакше macOS TCC вбиває наш Swift recorder. Скрипт: `scripts/patch-electron-info-plist.sh`, запускається з `postbuild.mjs`.
     - При першому запуску системний prompt → **Allow** для Microphone (а також Accessibility для push-to-talk hotkey, якщо ще не ввімкнено).
     - Після `npm install` треба один раз перезапустити `npm run desktop` — нові permission descriptions підхопить TCC.
     - Packaged build отримує ті ж keys через `package.json > build.mac.extendInfo`.
  3. Debug: `MARSHAL_DICTATION_DEBUG=1 npm run desktop` — поаналізувати keydown/keyup/recorder state (див. #49, #50)
- Translator: налаштувати `MARSHAL_API_KEY` у `.env` (див. `.env.example`)

---

## Стек проєкту
- Electron desktop app (TypeScript, ESM, strict)
- Chrome Extension (Manifest V3, TypeScript)
- Standalone agent (Playwright, Anthropic SDK, Claude/Codex CLI bridges)
- macOS-first (Swift helpers: pasteboard-watcher, майбутній audio-recorder)

## Архітектура на високому рівні
- `desktop/main.ts` — Electron main process, IPC hub, global shortcuts
- `desktop/backend-client.ts` — UtilityProcess клієнт до agent backend
- `desktop/translator/` — floating translator (Groq API + Swift pasteboard watcher)
- `desktop/renderer/` — UI (vanilla JS, без фреймворку)
- `agent/bridge/` — 7 reasoning bridges (claude-cli — default, codex-cli, api, claude, claude-web, playwright, extension)
- `agent/runtime/marshal.ts` — один-shot executor, Toolbox (shell, fs, browser)
- `chrome-extension/` — side panel для ChatGPT/Claude/Gemini + local HTTP bridge

## Код-стайл
- TypeScript strict, no `any`, 2-space indent, ES modules
- Коментарі в коді — виключно англійською
- Спілкування з користувачем — виключно українською
- Повний шлях до файлу завжди
- Production-grade код, без TODO/pseudo
