# Voice boards — design spec (#276)

Status: spec only, no code. Epic: #275 (Phase 4). Depends on #281 (resource budget) and #284 (assistant home). Language rules: epic #275, "Language" section.

## 1. Goal

A board window the owner fills by talking:

- "намалюй схему авторизації" → sequence or flowchart
- "draw the deploy flow" → flowchart
- "брейншторм: як монетизувати Marshal" → idea map with typed nodes

Two modes share one window, one op stream, one export path:

- **Diagram mode** — one Mermaid diagram per board, redrawn as the model answers.
- **Brainstorm mode** — typed idea map plus running summary, task list and open questions.

Out of scope for v1: multi-user editing, cloud sync, live shared canvas on calls (presenter window is Stage 5 only).

## 2. Output format options

Board content is produced by the model as text. Four candidate formats:

| Option | What the model writes | Render | Pros | Cons |
|---|---|---|---|---|
| **A. Mermaid text** | `flowchart TD …`, `sequenceDiagram …` | Mermaid in the board window (bundled, offline) | Model knows the syntax well; covers flowchart, sequence, class, state, ER, gantt, mindmap, timeline (the list in #276); text diffs cleanly; `.mmd` export is free | Strict parser: partial text does not render; one bad token breaks the block; layout is Mermaid's, not ours |
| **B. Raw SVG** | `<svg>…</svg>` | Inline in the window | No library; full control of look | Model layout of coordinates is poor; hard to edit by voice ("прибери вузол кеш" needs node identity); XSS surface if not sanitised |
| **C. HTML artifact (claude.ai Artifact tool)** | A published page | claude.ai hosting | Zero local code | **Rejected for boards.** Artifacts are published to claude.ai, private by default but still hosted off-machine. Board content is project and meeting data. Also not offline, and the owner's export must open offline (#276 "export opens offline"). Only usable for a one-off public explainer, not for the board itself |
| **D. Structured JSON ops → our own renderer** | `{"op":"addNode","id":"cache","label":"кеш","type":"risk"}` | Our own canvas/SVG layout | Stable node ids → voice edits and drag/fold/undo are exact; streaming op-by-op redraw is natural; brainstorm maps need this anyway | We own layout code; more work for diagram types |

**Recommendation:**

- **Diagram mode → A (Mermaid text)** as the model output, rendered by Mermaid. Mermaid covers every diagram type #276 lists; writing our own layout for ER/gantt/state is wasted effort.
- **Brainstorm mode → D (JSON ops)** with our own small canvas. Mindmap-like maps need stable ids and typed nodes that Mermaid does not give cleanly for editing.
- **Never B for model output** (layout quality and sanitising cost more than they save). SVG only as the export form of what Mermaid already drew.
- **Never C for boards** (see reason above). Artifact tool stays available for shareable explainers the owner asks for explicitly, not for the board window.

Diagram-mode edits by voice ("прибери вузол кеш", "add a retry arrow") are done by re-asking the model with the current Mermaid source plus the request, and replacing the whole block. Node-level patching of Mermaid is not worth building in v1.

### 2.1 Op stream (brainstorm, and the envelope for diagram mode)

One JSON object per line. The parser applies an op only when its line is complete (newline-terminated and valid JSON). Partial lines are never drawn.

Ops, first version:

- `addNode {id, label, type}` — type ∈ `idea | question | decision | risk | task`
- `addEdge {from, to, label?}`
- `updateNode {id, label?, type?}`, `removeNode {id}`, `removeEdge {from, to}`
- `setSummary {text}`, `setTasks {items[]}`, `setQuestions {items[]}`
- `setDiagram {mermaid}` — whole block; used by diagram mode and by voice edits

Rules:

- Ids are model-generated slugs, unique per board. Duplicate `addNode` id = update.
- Unknown op = dropped and logged, never fatal.
- Parser and op application are pure functions (testable without Electron), same style as `desktop/renderer/translator-alternatives.js`.

## 3. Rendering path and error handling

1. Model streams text through the existing agent bridge (`agent/bridge/`, default `claude-cli`). Stream parser splits on complete ops or complete fenced `mermaid` blocks.
2. Each complete op goes to the board renderer immediately (issue requirement: redraw as soon as an op arrives).
3. Diagram mode: Mermaid `parse()` runs before `render()`. On failure, the error text and the broken source go back to the model **once** for a fix. A second failure shows the last good render plus a small error line; never a broken board.
4. Mermaid runs inside the board window only. The window is created on open and destroyed on close (resource rule, section 5).
5. Mermaid `securityLevel: "strict"`; no HTML labels from model text beyond what Mermaid allows.

### 3.1 Known Mermaid traps to test in Stage 1

- Labels with `"`, `(`, `[`, `:`, `;`, `#` must be quoted. The model prompt must require `id["label"]` form for every label. A quoting test set is required.
- Cyrillic labels need a font that has Cyrillic glyphs. Set `fontFamily` to a bundled font (`desktop/renderer/fonts/`), not a system stack. Check the font list in `desktop/renderer/fonts/` before choosing.
- Diagram keywords (`flowchart`, `sequenceDiagram`, `participant`, …) are always English, even when the request is Ukrainian. The model writes syntax in English and labels in the request language.

## 4. Bilingual uk / en

Rules, aligned with the epic's Language section and with #330 (UI language):

- **Output language follows the request.** Speech in Ukrainian → labels, summary, tasks, questions in Ukrainian. Speech in English → English. Mixed → the language of the request sentence.
- **Setting overrides:** per-board setting `auto | uk | en` (default `auto`), same shape as `assistantLanguage` (#330). Forced language goes into the system prompt, not a post-translation step.
- **Technical terms stay as written** (CLAUDE.md rule): `rate limit`, `deploy`, `webhook`, `product_flat` are not translated in labels. The translator glossary (`translator-glossary.json`) is not reused for this; it is a translation tool, not a term policy for generated text. Decide in Stage 2 whether to pass the glossary as "do not translate" list (open question 4).
- **Diagram keywords and ids** stay English (Mermaid syntax and stable ids). Only visible labels and text fields are localised.
- **Prompt:** model is told the request language explicitly and to keep English identifiers. One test per language: same request in uk and en yields structurally equal diagrams with translated labels.
- **Speech out** (summary read aloud, if enabled) uses the existing `pronounceForUkrainian` path (`desktop/speech/speech-policy.ts`); no new TTS.
- **Export:** `.md` and `.json` keep the language of the board. Mermaid `.mmd` keeps English keywords with localised labels.

## 5. Resource impact (budget #281)

Budget: idle ≤ 300 MB for all processes, no always-on model, no Python runtime, heavy parts load on demand.

- **Idle:** zero cost. Boards exist only while the window is open. No timers, no watchers.
- **Board window open, idle:** one extra renderer process. The existing dashboard look (`desktop/renderer/dashboard.css`) and the assistant canvas rules apply: canvas that animates keeps the GPU pool (#310). Board window must **not** run a continuous animation. Rendering is event-driven (on op arrival).
- **Mermaid library:** the largest new item. Mermaid is multi-MB of JS once bundled, and first render is heavy (layout, DOM work). Plan: load it via dynamic `import()` only when a board opens, keep it out of the main bundle and out of the assistant home renderer. Measure with `npm run perf:footprint` at idle with the board closed and open, before and after first render (rule from #281). **Numbers are not measured yet** — this spec does not claim them.
- **Brainstorm canvas:** our own SVG/DOM, no library. Node count is small (tens), so no virtualisation in v1.
- **Model calls:** one stream per request, no polling. Repair retry is at most one extra call per diagram op.
- **Speech:** none added beyond the existing dictation/TTS stack. No new speech model.
- **Disk:** boards in `<userData>/boards/<id>/` (`board.json`, `board.md`, `board.mmd`, and later `board.html`). Small text files; no media.
- **Saved board list** lives in a JSON index, read on window open only.

If the Mermaid footprint breaks the budget, the fallback is: lazy-load it only on first diagram request and unload it after the board closes. Do not drop the feature.

## 6. Build vs buy

| Need | Build | Buy / reuse | Decision |
|---|---|---|---|
| Diagram rendering (flowchart, sequence, state, ER, gantt, mindmap, timeline) | No | **Mermaid** (MIT, npm, active project) | Use Mermaid. Pin version. Check licence and the exact version before adding the dependency |
| Diagram layout engine alternatives | — | Graphviz (native binary or WASM), D2 (Go binary) | Reject for v1: native binary or large WASM against the budget; Mermaid already covers the types |
| Brainstorm map canvas | Yes, small | Libraries (React Flow, Cytoscape, JointJS) need a framework or are large | Build a minimal canvas. Node count is small; no framework in the renderer (vanilla JS rule) |
| Drag, zoom, fold, undo | Build, small | — | Build on the same canvas |
| Stream parse of model ops | Build, pure | — | Build; tested with fixtures |
| Export to offline HTML | Build | — | Inline Mermaid-rendered SVG + CSS, no scripts beyond a tiny viewer; strict CSP like `recording-indicator.html` |
| PDF export | Use `printToPDF` of the offline HTML in a hidden window | Third-party PDF libs | Reuse Electron print; no new dependency |
| Hosted diagram tools (draw.io, Excalidraw cloud, Miro) | — | — | Reject: data leaves the machine; conflicts with the local-first rule |

No new Python runtime. No new native binary in v1.

## 7. Export

- `board.html` — self-contained, offline, strict CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src data:`), no network, opens in any browser.
- `board.md` — summary, tasks, questions, and diagram source in fenced blocks.
- `board.mmd` — Mermaid source (diagram mode only).
- `board.json` — the op log or final state. Lets the board be re-opened and edited.
- PDF — printed from the offline HTML.

The export must work with Wi-Fi off. A test opens `board.html` with network blocked.

## 8. Presenter window (Stage 5)

Separate window for sharing on a call. It follows the captions rule: content-protected does **not** apply here (the owner wants to share it). Light variant allowed for projectors (#276 Design). The presenter window reads the same board state; no second model call.

## 9. Design

Board and presenter use the assistant look from #283 (tokens in `desktop/renderer/design-tokens.css`, no hex in components). Board chrome reuses `dashboard.css` classes (`.shell`, `.bar`, `.block`). Node colours come from state tokens by node type: `idea`, `question`, `decision`, `risk`, `task`.

## 10. Staged delivery

Each stage is a separate PR, each gated by the #281 footprint check.

- **Stage 0 — spec (this PR).** `docs/VOICE_BOARDS.md` only.
- **Stage 1 — parser and renderer core.** Pure op parser, Mermaid render with parse-then-render and one repair retry, quoting test set, Cyrillic font check. No voice yet: driven from a text box in a dev build. Tests: parser fixtures, quoting cases, repair path with a stub model.
- **Stage 2 — diagram mode by voice.** Hotkey/dock entry, request → model → Mermaid, language setting, `board.mmd` save. e2e with stubbed model draws a board (issue "Done when").
- **Stage 3 — brainstorm mode.** Op stream, typed nodes, summary/tasks/questions panels, role switch (structure / challenge / both).
- **Stage 4 — edits and export.** Drag, rename, fold, undo, voice edits by replacing source, saved-board list, `board.html` / `.md` / `.json`, offline export test.
- **Stage 5 — presenter window and PDF.** Separate window, PDF via print.
- **Later (not planned):** sub-boards (architecture, roadmap, plan) and handoff of the plan sub-board to the plan runner (#278). Keep out of v1 unless #278 is ready.

Speech answers at pauses / only when asked / text only (issue) — decide in Stage 2; default: text only, speak a one-line confirmation.

## 11. Open questions

1. **Mermaid licence and pin:** confirm MIT and the exact version; check its footprint with `perf:footprint` before committing to it.
2. **CSP of the board window:** Mermaid may need `unsafe-eval` or inline styles. Test; if `unsafe-eval` is needed, decide whether that is acceptable for a window that renders model text. Prefer not.
3. **"From code" source reading:** reading the project folder for a module map must be limited to the allowed roots, like `claudeCodeRoutingRoots` (#303). Confirm the same setting is reused, or a new one added.
4. **Glossary as "do not translate" list:** reuse the translator glossary for brainstorm/diagram labels, or keep a separate list? Owner decides.
5. **Streaming in the bridge:** confirm `claude-cli` bridge streams text deltas in the form the parser needs. Not verified here; check `agent/bridge/claude-cli-bridge.ts` in Stage 1.
6. **Repair retry cost:** one retry per failed diagram. Confirm the owner accepts the extra call.
7. **Speech out default:** text only, or one-line spoken confirmation?
8. **Board index size limit:** how many boards to keep before pruning. Proposal: 100 boards, oldest pruned, export files kept if the owner marked them.
9. **Sub-boards and plan handoff:** depends on #278 scope; not decided here.

## 12. Verification for this spec

- Read: issue #276, epic #275 (both via `gh issue view`).
- Checked repo: no Mermaid, no diagram code and no SVG renderer exists in `desktop/`, `agent/` or `chrome-extension/` at the time of writing. Renderer has `icons.js`, `dashboard.css`, `design-tokens.css`, a bundled `fonts/` folder, and a `neural-smoke.mp4`. CSP pattern exists in `desktop/renderer/*.html`.
- Not measured: Mermaid bundle size and memory. All footprint numbers above are targets, not measurements.
