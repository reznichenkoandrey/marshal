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
- E2E у реальному Electron — окремо від vitest: `npm run test:e2e` (smoke),
  `npm run test:e2e:capture` (редактор захоплення), `npm run test:e2e:region`
  (геометрія виділення області), `npm run test:e2e:history` (вікно історії знімків),
  `npm run test:e2e:alternatives`
  (перекладач: клік по слову → альтернативи), `npm run test:e2e:captions` (живий рядок
  субтитрів)
- Тести живуть у `tests/` на рівні проєкту
- Нові pure helpers мають бути `export`-нуті з testable форми (не внутрішні методи)
- Перед коммітом: `npm run check` (typecheck + test)

### First-run setup
- **macOS codesign cert (ОБОВ'ЯЗКОВО для dev):**
  1. `npm run setup:codesign-cert` — створює self-signed `Marshal Self-Signed` cert у keychain. Двічі попросить `sudo` (`security remove-trusted-cert` + `security add-trusted-cert`) — це нормально, скрипт надрукує точні команди.
  2. Перевірка: `security find-identity -v -p codesigning | grep "Marshal Self-Signed"` — має бути хоча б один рядок без "Invalid Key Usage".
  3. Чому це потрібно: без stable cert `npm run build` підписує bundle ad-hoc → новий CDHash щоразу → macOS TCC вважає це новим app → знову запитує Microphone/Screen Recording/Accessibility. Зі stable cert + фіксованим bundle ID `com.marshal.desktop.dev` grants зберігаються назавжди (див. #84).
  4. Якщо TCC після переходу на stable cert все одно показує `com.github.Electron` зі старими grants: `tccutil reset All com.github.Electron && tccutil reset All com.marshal.desktop.dev`, після цього один раз `Allow` — і тиша.
- Voice dictation:
  1. `npm run setup:dictation` — збирає `whisper-cli` у `.whisper/` і кладе модель
     (`ggml-large-v3-turbo`, 1.5 ГБ) у `~/Library/Application Support/Marshal/models/`.
     **Модель НЕ в репо і НЕ в бандлі** (див. #151): вона робила DMG 1.5 ГБ при застосунку
     під 100 МБ. Одна копія на всі білди, переживає перевстановлення; override —
     `MARSHAL_MODELS_DIR`. У packaged білді ставиться з tray → «Download Dictation Model…».
     `WHISPER_MODEL=ggml-small` — 465 МБ замість 1.5 ГБ, гірше на коротких фразах.
     **Модель тримається в пам'яті — `whisper-server` (#218).** `whisper-cli` на кожну фразу
     заново вантажить 1.5 ГБ і ініціалізує Metal: на M3 Pro це 1.6 с, **незалежно від
     довжини** (3 с і 9 с однаково). Один `whisper-server` на весь застосунок відповідає за
     ~0.6–0.7 с, а одночасні запити ставить у чергу замість того, щоб вантажити дві копії
     моделі (так фінал субтитрів сповзав до 4.7–11.3 с, #219). Стартує при першій потребі,
     гаситься після 10 хв простою (`desktop/dictation/whisper-server.ts`), зупиняється з
     застосунком; усе, що заважає серверу, падає на `whisper-cli` — повільніше, але не зламано.
     **Жоден запит не чекає на старт сервера:** поки він піднімається, фразу бере
     `whisper-cli`. Перший старт після інсталу — **13 с** (Gatekeeper перевіряє свіжопідписаний
     бінарник, заміряно), далі ~1 с; блокувати на цьому диктовку означало б зробити її
     повільнішою, ніж до #218. `MARSHAL_WHISPER_SERVER=0` — вимкнути. `setup:dictation` збирає
     обидва бінарники; підписує їх electron-builder разом з рештою бандла.
  2. **macOS permissions для `npm run desktop` (dev mode):**
     - `npm run build` автоматично патчить `node_modules/electron/dist/Electron.app/Contents/Info.plist` (додає `NSMicrophoneUsageDescription` + `NSScreenCaptureUsageDescription` + `CFBundleIdentifier=com.marshal.desktop.dev`), підписує bundle stable identity `Marshal Self-Signed` (якщо cert встановлений) і підписує всі Swift helpers (`audio-recorder`, `screen-recorder`, `scroll-capture`, `scroll-stitch`, `apple-vision-ocr`, `send-keystroke`) тією ж identity. Скрипти: `scripts/patch-electron-info-plist.sh` + `scripts/postbuild.mjs`.
     - При першому запуску системний prompt → **Allow** для Microphone (а також Accessibility для push-to-talk hotkey, якщо ще не ввімкнено).
     - Packaged build отримує ті ж keys через `package.json > build.mac.extendInfo` + stable identity `099164E16AE88B2052B842BE1036FB10411B7239`.
  3. Debug: `MARSHAL_DICTATION_DEBUG=1 npm run desktop` — поаналізувати keydown/keyup/recorder state (див. #49, #50)
- Translator: налаштувати `MARSHAL_API_KEY` у `.env` (див. `.env.example`).
  **Для встановленого застосунку — `npm run setup:env`**: packaged білд шукає `.env` у своїй
  userData-теці, бо той, що в репо, лежить усередині `.app`. Тека зветься за top-level
  `productName` з package.json — `~/Library/Application Support/Marshal/` (з #158; до того була
  `local-chatgpt-agent/`, і перший запуск нової збірки один раз копіює її вміст, стару теку не
  чіпає). Шлях не хардкодити: скрипт виводить його сам, а Settings → Setup health друкує те, що
  реально зарезолвив запущений застосунок.
  Без ключа `auto` падає на CLI-backend і переклад займає ~10 с замість «менше секунди»,
  через що переклад під час набору перетворюється в лаг (#155).
- **Marshal — LSUIElement застосунок: немає іконки в Dock і рядка в ⌘Tab.** Наслідок, який
  ламає вікна: звичайне вікно, що опинилось за іншим, **неможливо підняти жодним системним
  способом**. Тому перекладач, закріплений скріншот і редактор захоплення тримаються
  `alwaysOnTop`, а не тому, що «так гарніше» (#168). Додаєш нове вікно — або роби його
  floating, або дай шлях назад через tray; `BrowserWindow.focus()` сам по собі для
  LSUIElement не спрацьовує, потрібен `app.focus({ steal: true })`.
- **Вікно перекладача не ховається, поки в полі є текст** (#166). `blur` прилітає від
  нотифікацій і застосунків, що стартують, — це не рішення викинути набране. Порожнє вікно
  ховається як і раніше. Правила живуть у `desktop/translator/window-policy.ts` окремо від
  Electron саме щоб бути тестованими; renderer повідомляє лише переходи порожнє↔непорожнє.
  `⌘⌥T` тепер тумблер, а не «завжди перекласти буфер»: на порожньому буфері він раніше не
  робив **нічого**, і єдиним шляхом назад було головне вікно.
- **Glossary перекладача — не декорація, а виконання правила «технічні терміни не
  перекладати».** Іконка книги у вікні перекладача. Термін без перекладу = лишити як є
  (`backoff`, `rate limit`, `product_flat`); з перекладом = саме так і рендерити
  (`cache tag` → `тег кешу`). Сховище — `translator-glossary.json` в userData. У промпт
  ідуть **лише терміни, що є в тексті** (`selectGlossaryEntries`) — інакше довгий список
  роздуває кожен запит і розмиває інструкцію. Матчинг на межі слова через `\p{L}`
  lookaround, не `\b`: `\b` ASCII-only і кириличні терміни промахує (#147).
- **Альтернативні переклади — клік по слову в правій панелі** (#146). Переклад рендериться
  не одним текстовим вузлом, а словами-спанами (`desktop/renderer/translator-alternatives.js`:
  токенізація, межі речення, застосування вибору — чисті функції, тестовані без Electron).
  Запит іде **на речення, не на весь текст**, і кожна альтернатива повертається разом із
  **повністю переписаним реченням**: DeepL після вибору переписує хвіст другим запитом, а тут
  один запит дає і список, і готовий результат, тому вибір застосовується миттєво. Кеш —
  по `(мова, речення, слово, зсув)`, тож повторний клік безкоштовний. Контракт промпту й
  парсер — `desktop/translator/backends/alternatives.ts`; метод `suggestAlternatives`
  **опціональний** у `TranslatorBackend`, бо Apple Vision — OCR-only, і сервіс перетворює
  його відсутність на повідомлення з назвою провайдера, а не на краш. Перевірка UI —
  `npm run test:e2e:alternatives` (реальний renderer у Electron зі stub-preload, без ключа
  й без мережі).
- **Модель перекладача — `MARSHAL_TRANSLATOR_MODEL`, не `MARSHAL_MODEL`.** Друга спільна з
  агентськими бриджами. Дефолт — `qwen/qwen3.8-27b` (заміряно 127–559 мс на речення проти
  556–1631 мс у gpt-oss, ідентифікатори й переноси зберігає). Набір моделей у Groq **змінюється**:
  `llama-3.3-70b-versatile` зник і 404-ив кожен переклад (#162). Що є на акаунті —
  `GET /v1/models`, не вгадувати. 404 `model_not_found` тепер падає на CLI, як і 401 (#160).
- **Live captions (`desktop/captions/`) — оверлей, якого не видно у screen share.** Це не
  «красивий» always-on-top, а `setContentProtection(true)` (`NSWindow.sharingType = .none`) плюс
  `setIgnoreMouseEvents(true)`: Zoom/Meet/OBS бачать шпалери, кліки проходять наскрізь. Мишу
  вікно приймає лише поки утримується `MARSHAL_CAPTIONS_DRAG_MODIFIER` (дефолт `LeftControl`,
  через `ptt-monitor`) або увімкнено tray → Move Overlay. Аудіо — окремий Swift helper
  `system-audio-tap` (ScreenCaptureKit → 16 kHz mono PCM у stdout), **не** meeting-recorder:
  той пише один M4A до стопу, а субтитрам потрібен потік. Нарізка на фрази — `segmenter.ts`
  (energy VAD, чистий і тестований); whisper — той самий `WhisperBackend`, що в диктовці;
  summary — стрімінг (`summarizer.ts`, Anthropic SDK або OpenAI-compatible SSE; `auto` бере
  Claude, якщо є `ANTHROPIC_API_KEY`, **з fallback на OpenAI-compatible**: ключ ≠ придатний
  ключ — перший акаунт мав ключ без кредитів, і кожне summary падало (#214). Непридатний =
  401/403, 400 «credit balance», 404 моделі; 429/5xx — ні. Перемикання липке на сесію і не
  повторює запит, що вже показав текст. Явно вибраний провайдер не обгортається), рендер markdown → HTML робиться в main
  (`renderSummaryHtml`), renderer лише малює. Промпт summarizer'а — дослівно зі спеки V3
  (business scribe, #211), не «покращувати». **Обсяг — нотатки й переклад**
  (`docs/LIVE_CAPTIONS_V3.md`): режими, де summary відповідав на питання чи говорив від першої
  особи за CV (V2, #187/#188), прибрані в #211 і не повертаються — це стережуть тести
  `scribe-only scope`. Reference-файли — лише фон для термінології (агенда, глосарій). OCR-регіон обирається один раз
  crop-оверлеєм і зберігається в `captions-overlay-state.json`; під час знімка оверлей
  ховається, щоб не зняти сам себе.
  **Чому фрази більше не ріже посередині (#202):** під Silero абсолютний RMS-поріг — це
  `classifierMinRms` (120, env `MARSHAL_CAPTIONS_MIN_RMS`), а не `minSpeechRms` (350). Друге
  калібрувалось як нижня межа *адаптивного* порогу в energy-режимі; як самостійний гейт під
  моделлю воно глушило тиху мову, і фраза закривалась, поки людина ще говорила. Піднімати
  `MARSHAL_CAPTIONS_SILENCE_MS` замість цього — обмін різання на затримку (#203), бо текст
  з'являється лише після закриття фрази. Другий шар — склейка в `transcript-buffer.ts`:
  рядок **без термінальної пунктуації**, за яким протягом 1.2 с іде текст **з малої літери**,
  дописується до нього, а не лягає окремим. Обидві умови обов'язкові: сама лише відсутність
  крапки збігається з короткими завершеними репліками, які whisper не пунктуює, і вони
  склеювались в один нескінченний рядок.
  **Живий рядок під час мовлення (#203):** раніше на оверлеї не було **нічого**, доки фраза
  не закриється, а `maxSegmentMs` дозволяє говорити до 9 с — метрика «0.5 с після speech end»
  цього не показувала, бо міряла не від того моменту. Тепер сегментер віддає `reason:
  "partial"` кожні `MARSHAL_CAPTIONS_PARTIAL_MS` (1000) мовлення, і сервіс малює його окремим
  приглушеним рядком. Partial **ніколи** не йде в `transcript-buffer` і не планує summary —
  інакше summary реагував би на півфрази і ламав #189. Правила допуску — `partial-policy.ts`:
  один запит у польоті, жодного поки чекає фінал, і **без локального fallback**: `hybrid` на
  Groq 429 запускає whisper.cpp, тож partial, що з'їв ліміт, потягнув би на повільний шлях і
  фінальні субтитри. Тому partials ідуть напряму в Groq, а перший збій вимикає їх на 60 с.
  **STT субтитрів за замовчуванням — локальний** (#208): `auto` бере whisper.cpp, щойно модель
  встановлена (з #218 модель резидентна, ~0.7 с на фразу — майже як Groq, але без його
  20 RPM, які живий рядок вичерпував, #217); без моделі — як у диктовки. Явний вибір у
  Settings завжди виграє (`stt-choice.ts`). `MARSHAL_CAPTIONS_PARTIALS`: увімкнено на всіх
  backend-ах, `0` — вимкнути. Локальний partial іде **лише через резидентний сервер**
  (`transcribeIfResident`): поки той прогрівається, прохід пропускається, а не йде через
  `whisper-cli` — інакше 1.6 с і фінал поруч сповзав до 4.7–11.3 с (#219).
  Довгий живий рядок обрізається **зліва** (найсвіжіші слова в кінці); перевірка —
  `npm run test:e2e:captions`. **Partial надсилає лише хвіст фрази** (`partialWindowMs`, 3 с):
  раніше кожен надсилав усю відкриту фразу, і вартість росла квадратично — 9-секундне речення
  коштувало ~36 с аудіо до фіналу, ліміт Groq вичерпувався за секунди (#207). Інтервал —
  1500 мс. Пауза після 429 береться з Groq-ового «Please try again in …», а не фіксовані 60 с,
  і помилка логується **повністю**: назва вичерпаного ліміту стоїть у кінці повідомлення.
  **Живий переклад субтитрів (#210):** кожен **фінальний** рядок іде через `TranslatorService`
  (backend із Settings і глосарій — ті самі, що у вікні перекладача), живий рядок — ні, бо
  змінюється щосекунди. `caption-translation.ts`: кеш «текст → переклад», тому відповіді не по
  черзі нічого не плутають, а склеєний рядок (#202) — просто новий ключ. Переклад, що повторює
  оригінал (whisper уже видав цільову мову), не показується; після збою — пауза 30 с, а не
  запит на кожен рядок. **Не пропускати переклад за `detectScriptLang`:** він зводить усю
  кирилицю до `uk`, і російська лишилась би без перекладу. Оверлей: переклад — основний рядок,
  оригінал дрібно лише під останнім. `MARSHAL_CAPTIONS_TRANSLATE` — код мови (дефолт `uk`) або
  `off`.
  **Тестувати звук — не через `say`:** між реченнями він перезапускає аудіо-вихід, і
  ScreenCaptureKit губить усе після першого. Рендерити файл (`say -o`) і грати `afplay`, або
  живий дзвінок. Довкола *цифрової* тиші macOS гейтить ~1 с виходу (у реальному звуці нулів
  немає — не баг тапа). Перший exec свіжопідписаного Swift helper-а після інсталу — ~35 с
  Gatekeeper-перевірки (#181), тому Vision-helper прогрівається на старті.
- **Виділення області: вікно оверлею мусить стояти рівно на початку дисплея.** Cocoa
  затискає звичайне вікно у «видиму» область і зсуває його під menu bar — просили
  `y=0`, отримали `y=39`, і `setBounds` назад не повертає. `clientY` оверлею тоді на
  39 пунктів менший за екранний Y під курсором, і кроп бере прямокутник **вище** того,
  що людина намалювала: розмір PNG правильний, кадр — ні (#223). Лікує
  `enableLargerThanScreen: true`, рівень вікна лишається `screen-saver`, бо воно тепер
  накриває menu bar. Оверлей живе в одному місці — `desktop/capture/crop-overlay.ts`;
  його відкривають і capture studio, і OCR перекладача, і регіон субтитрів, тож
  дублювати конструктор вікна означає розмножити цей самий дефект. Перевірка —
  `npm run test:e2e:region`: маркерне вікно на відомому місці екрана, драг навколо нього
  й скан PNG на те, куди маркер ліг. **Драг там подається в екранних координатах і
  переводиться через реальні bounds оверлею** — без цього харнес зсуває власний ввід
  рівно на стільки, на скільки дефект зсуває кроп, вони компенсуються, і зламана збірка
  проходить.
- **Кожен знімок потрапляє в історію, навіть якщо його тільки скопіювали** (#225).
  Історія раніше читала лише теку знімків і лишала файли з префіксом `Marshal ` — а
  найчастіший шлях (зняв → підписав → ⌘C → закрив) не лишає файлу взагалі, тож у
  історії не було саме того знімка, який найчастіше треба повернути. Тепер
  `desktop/capture/capture-archive.ts` пише копію в `<userData>/capture-history/` у
  момент відкриття редактора, а `Copy`/`Save`/`Pin` **перезаписують той самий запис**
  зробленою версією — одна сесія захоплення = один рядок історії, з анотаціями, а не
  оригінал плюс майже-дублікат. Архів — **не** тека користувача: його ріже retention
  (300 записів / 600 МБ, `planPrune`), а видаляти файли, які людина зберегла свідомо,
  не можна. Вікно історії показує обидва джерела злитими (`capture-history-list.ts`,
  дедуплікація по «той самий розмір у ту саму хвилину», перевага — файлу користувача);
  пошук і групування по днях — у renderer (`capture-history-filter.js`), бо список уже
  в нього надісланий і читати диск на кожну літеру немає сенсу. Ярлик «Not saved» на
  плитці — щоб `Reveal` у теці application support не був сюрпризом.
- **`Copy` у редакторі захоплення закриває вікно** (#224). Copy — термінальна дія:
  людина отримала те, по що прийшла, а вікно через LSUIElement висить над усім, поки
  його не закриють руками. Підтвердження переїхало в системну нотифікацію, бо тост
  усередині вікна помер би разом із ним. `Save`/`Pin` вікно не закривають — просили
  саме про Copy.
- **Встановлення свіжого білду на свою машину — `npm run install:local`** (не тягнути DMG
  руками). Білди self-signed і не нотаризовані, тому macOS вішає `com.apple.quarantine` і
  блокує перший запуск. Скрипт гасить запущений Marshal, копіює з образу в `/Applications`,
  знімає атрибут і перевіряє підпис — діалогу немає взагалі (#153). Нотаризація прибрала б
  його і для сторонніх, але потребує `Developer ID Application`, тобто платного Apple
  Developer Program — поки не купуємо.

---

## Стек проєкту
- Electron desktop app (TypeScript, ESM, strict)
- Chrome Extension (Manifest V3, TypeScript)
- Standalone agent (Playwright, Anthropic SDK, Claude/Codex CLI bridges)
- macOS-first (Swift helpers: pasteboard-watcher, майбутній audio-recorder)

## Архітектура на високому рівні
- `desktop/main.ts` — Electron main process, IPC hub, global shortcuts
- `desktop/backend-client.ts` — UtilityProcess клієнт до agent backend
- `desktop/translator/` — floating translator: two-pane window, 42-language registry
  (`languages.ts` — single source of truth, renderer gets it over IPC), translate-as-you-type,
  insert-into-app (`insert-service.ts`), 5 backends under `backends/`, Swift pasteboard watcher
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
