# Marshal macOS Menu Bar App Plan

## Status

- Created: `2026-03-19`
- Scope: design and implementation roadmap
- Target: a macOS menu bar app that wraps Marshal without rewriting the agent runtime

## Why This Exists

The current operator surface is a local web console opened in Chrome at `http://127.0.0.1:3489`. That works for development, but it has product-level friction:

- it depends on a visible browser tab for operator control
- it splits state across the browser window, the Chrome ChatGPT tab, and shell scripts
- it does not feel like a native desktop utility
- it makes lifecycle operations like start, restart, health, and bridge status harder to reason about

The menu bar app should become the primary operator surface on macOS while keeping the existing Marshal runtime, task orchestration, and ChatGPT bridge logic.

## Current Architecture Summary

The good news is that most of the hard backend pieces already exist and should be reused:

- The agent execution boundary is already centralized in [`agent/runtime/marshal.ts`](../agent/runtime/marshal.ts).
- Session persistence, per-session workspaces, uploads, and task history already live in [`operator/session-store.ts`](../operator/session-store.ts).
- The operator server already exposes a small local API in [`operator/server.ts`](../operator/server.ts).
- The ChatGPT connection is already abstracted behind a bridge factory in [`agent/bridge/factory.ts`](../agent/bridge/factory.ts).
- The extension bridge already runs through a localhost bridge server in [`agent/bridge/local-bridge-server.ts`](../agent/bridge/local-bridge-server.ts).

The current weakest seam is that operator orchestration is still coupled to the HTTP server:

- task queueing, session mutation, and runtime event flattening are mixed into `OperatorServer`
- the web UI only sees stringified events rather than structured runtime events
- file ingress is web-shaped because uploads are converted to base64 in the browser client

## Research Summary

### Option A: Electron menu bar shell

Fit with this repo:

- Strongest fit for v1.
- The project is already Node.js + TypeScript.
- Electron already has a main process, renderer processes, tray APIs, hidden-accessory app mode, and a Node-capable utility process.
- We can reuse existing TypeScript runtime code directly instead of introducing Rust or Swift for core orchestration.

What Electron gives us:

- A tray/menu bar entry point via `Tray`.
- A Dock-less app mode on macOS via `app.setActivationPolicy('accessory')`.
- A separate Node-capable child process via `utilityProcess.fork(...)` for isolating Marshal backend work from the desktop shell UI.
- A normal renderer window for a compact native-feeling operator panel.

Tradeoffs:

- Larger bundle size than Tauri or native Swift.
- We must be strict about preload + IPC boundaries and not expose Node primitives directly to the renderer.

Assessment:

- Best choice for v1 because it preserves implementation speed and reuse.

### Option B: Tauri menu bar shell with Node sidecar

Fit with this repo:

- Technically viable, but a worse v1 fit.
- Tauri tray support is solid and Tauri documents both tray handling and Node.js sidecars.
- However, it introduces a Rust shell plus sidecar packaging, target-triple binary management, shell permissions, and a second app architecture around the current Node runtime.

Tradeoffs:

- Smaller app footprint than Electron.
- Better native feel than Electron by default.
- Higher integration cost for this codebase right now.
- More packaging complexity because Marshal would still live as a bundled sidecar binary or embedded Node runtime.

Assessment:

- Good candidate for a later optimization pass, not the first production menu bar implementation.

### Option C: Native SwiftUI/AppKit menu bar app

Fit with this repo:

- Best macOS-native UX on paper.
- Worst near-term fit for this codebase.
- Apple’s `MenuBarExtra` is a clean native path for a menu bar utility, but we would still need to host or supervise the existing Marshal Node runtime somehow.

Tradeoffs:

- Strongest native platform integration.
- Highest implementation cost and the largest architecture split.
- Would force us to maintain a native shell and a separate JS runtime stack from day one.

Assessment:

- Long-term possibility only if Marshal becomes a macOS-only product and native polish matters more than shipping speed.

## Recommended Direction

Build **v1 as an Electron menu bar app** on top of the current project.

More specifically:

1. Keep the existing agent runtime, ChatGPT bridge, and session store.
2. Extract operator orchestration out of `OperatorServer` into a transport-neutral service layer.
3. Add an Electron shell that:
   - owns app lifecycle
   - owns menu bar / tray UI
   - launches a compact renderer panel
   - hosts Marshal backend work in a separate Electron utility process
4. Keep the current web operator console as a development fallback until the native shell reaches parity.

This gives the best balance of:

- speed to first usable app
- reuse of existing Node/TS code
- safer runtime isolation than “everything in Electron main”
- a clean path to packaging, autostart, and future desktop polish

## Target Architecture

### Layer 1: Core Marshal runtime

Keep and reuse:

- `runMarshalTask`
- `FileSandbox`
- `ShellTool`
- `BrowserTool`
- `AgentLoop`
- ChatGPT bridge implementations
- `MemoryStore`

No menu bar code belongs here.

### Layer 2: Operator domain service

Create a new transport-neutral service module, tentatively:

- `operator/task-service.ts`
- `operator/event-bus.ts`

Responsibilities:

- create/list/delete projects and sessions
- submit tasks
- manage per-session queueing
- resume queued tasks after restart
- expose structured task/runtime events
- mediate attachments and workspace initialization

This layer should depend on:

- `OperatorSessionStore`
- `runMarshalTask`

This layer should not depend on:

- HTTP request/response objects
- browser DOM
- Electron APIs

### Layer 3: Transport adapters

Two adapters should sit on top of the operator domain service:

- `OperatorServer` as the existing localhost HTTP adapter
- Electron IPC adapter for the menu bar app

This is the key refactor that prevents us from hard-coding the desktop app to the current web server shape.

### Layer 4: Electron shell

Proposed structure:

- `desktop/main.ts`
- `desktop/preload.ts`
- `desktop/renderer/*`
- `desktop/backend.ts` or `desktop/utility/*`

Responsibilities:

- create tray/menu bar icon
- set macOS accessory activation policy
- open/close/toggle a compact operator window
- show health/state in menu items
- launch backend utility process
- bridge renderer IPC to backend commands
- surface notifications and errors

### Layer 5: Chrome/ChatGPT control surface

Do not replace this in v1.

Keep:

- the Chrome profile launcher
- the extension bridge
- the real ChatGPT tab workflow

But move control into the desktop shell:

- “Open ChatGPT”
- “Reconnect Bridge”
- “Restart Marshal”
- “Open Execution Log”
- “Open Session Workspace”

## Product Scope For v1

The first menu bar release should support:

- tray icon with running/waiting/error states
- compact panel window with:
  - project selector
  - session list
  - message history
  - task composer
  - route selector
  - execution log
- native file attachment picker
- native workspace folder selection for a session or project
- explicit Chrome/bridge status
- buttons to open ChatGPT, restart backend, and inspect session files
- persistent history using the existing session store

v1 should not try to solve:

- Telegram integration
- multi-user sync
- cloud sync
- App Store sandboxing
- replacing the ChatGPT bridge with a fully native OpenAI API mode

## Key Design Decisions

### 1. Backend isolation

Recommendation:

- Run Marshal backend logic in an Electron utility process, not in the Electron main process.

Why:

- task execution, Playwright usage, and browser bridge work are more failure-prone than menu UI code
- utility process boundaries reduce the chance that runtime failures kill the menu bar shell
- Electron explicitly positions utility processes as Node-capable child processes for crash-prone or heavy components

### 2. Keep structured runtime events

Current issue:

- `OperatorServer` flattens runtime events into strings before persistence and UI rendering

Recommendation:

- persist both:
  - structured event payload
  - human-readable message

Why:

- native UI needs more than text blobs
- progress indicators, status badges, filters, and diagnostics should key off structured data

### 3. Native file/workspace selection

Current issue:

- filesystem writes are sandboxed per session workspace, but the UI still invites the user to think in arbitrary absolute paths

Recommendation:

- make workspace selection explicit in the native app
- let the menu bar app choose:
  - default project workspace
  - session workspace override
  - “import file into workspace” flow

This is the right fix for the earlier `/Users/.../temp` confusion.

### 4. Keep the web console during migration

Recommendation:

- do not delete `operator/static/*` in the first desktop milestone

Why:

- it remains useful as a developer console and fallback surface
- it reduces migration risk
- it gives us parity targets for the menu bar UI

## Proposed Phases

### Phase A. Operator service extraction

Goal:

- split transport-neutral orchestration from `OperatorServer`

Deliverables:

- `OperatorTaskService`
- reusable queue management
- reusable task execution lifecycle
- reusable structured event emission

Done when:

- the HTTP server becomes a thin adapter over the service
- no core orchestration logic lives only in the server layer

### Phase B. Event model hardening

Goal:

- preserve structured runtime events end-to-end

Deliverables:

- typed event payloads persisted to session data
- human-readable event formatting as a presentation concern
- clear statuses for bridge disconnected / bridge ready / task queued / task running / task failed

Done when:

- desktop UI can render progress without string parsing

### Phase C. Electron shell scaffold

Goal:

- add an Electron desktop shell without changing existing Marshal behavior

Deliverables:

- `desktop/` app scaffold
- tray icon
- accessory activation policy on macOS
- toggleable compact window
- renderer + preload + IPC skeleton

Done when:

- app launches from the menu bar and can show a placeholder panel

### Phase D. Backend utility process

Goal:

- isolate backend/runtime work from desktop shell UI

Deliverables:

- Electron utility process entrypoint
- IPC command channel for:
  - health
  - projects
  - sessions
  - submit task
  - cancel/restart backend
- stdout/stderr capture for diagnostics

Done when:

- closing and reopening the panel does not affect the backend
- backend crashes can be surfaced and recovered without killing the shell

### Phase E. Native operator panel

Goal:

- replace the browser-hosted operator UI with an Electron renderer panel

Deliverables:

- project selector
- session list
- message list
- task composer
- route selector
- event log
- task state badges

Done when:

- core operator flow is possible entirely inside the app

### Phase F. Native attachments and workspace controls

Goal:

- remove browser-only attachment assumptions and make workspace behavior explicit

Deliverables:

- file picker integration
- “open workspace” action
- configurable project/session workspace root
- UI copy that explains filesystem limits clearly

Done when:

- file tasks are understandable and repeatable from the native app

### Phase G. Chrome and bridge lifecycle controls

Goal:

- make ChatGPT/bridge state operable from the menu bar app

Deliverables:

- status row for:
  - Chrome profile session
  - extension bridge health
  - current ChatGPT project
- actions:
  - open ChatGPT
  - reconnect bridge
  - restart Marshal backend
  - open latest session logs

Done when:

- the desktop app becomes the control plane for the existing ChatGPT workflow

### Phase H. Packaging and startup

Goal:

- make the app installable and usable as a background utility

Deliverables:

- packaged macOS app
- code signing plan
- tray icon assets
- launch at login support
- single-instance behavior

Done when:

- the app can be started from Applications and optionally from login items

## Risks And Mitigations

### Risk: desktop shell and backend share too much state

Mitigation:

- isolate backend in utility process
- keep renderer IPC narrow

### Risk: ChatGPT bridge remains the real operational bottleneck

Mitigation:

- treat Chrome/extension state as first-class app status
- build reconnect and diagnostics into the tray menu and panel

### Risk: filesystem UX stays confusing

Mitigation:

- expose workspace root explicitly
- avoid implying arbitrary path writes are supported when sandboxed mode is active

### Risk: migration drags because web and desktop UIs diverge

Mitigation:

- extract operator service first
- keep the current web console as a parity harness until the native panel is proven

## Acceptance Criteria

The menu bar app initiative is only complete when all of the following are true:

1. Marshal can be controlled without opening the browser-hosted operator console.
2. The app exposes current bridge/backend health at a glance from the menu bar.
3. A user can create a session, submit a task, attach files, and inspect progress from the panel.
4. Session history persists across restarts.
5. The app explains workspace limits clearly enough that file-task results are trustworthy.
6. Backend failures are visible and recoverable from the shell UI.

## Suggested Implementation Order

Build in this order:

1. Extract operator service from HTTP server.
2. Preserve structured runtime events.
3. Add Electron shell and utility process.
4. Build a compact renderer panel for sessions/tasks.
5. Add file picker and workspace controls.
6. Add Chrome/bridge lifecycle controls.
7. Package and sign the app.

## Sources

- Apple SwiftUI `MenuBarExtra`: [developer.apple.com/documentation/swiftui/menubarextra](https://developer.apple.com/documentation/swiftui/menubarextra)
- Apple WWDC22 `Bring multiple windows to your SwiftUI app`: [developer.apple.com/videos/play/wwdc2022/10061](https://developer.apple.com/videos/play/wwdc2022/10061/)
- Electron process model: [electronjs.org/docs/latest/tutorial/process-model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- Electron `BrowserWindow`: [electronjs.org/docs/api/browser-window](https://www.electronjs.org/docs/api/browser-window)
- Electron tray tutorial: [electronjs.org/docs/latest/tutorial/tray](https://www.electronjs.org/docs/latest/tutorial/tray)
- Electron `app.setActivationPolicy`: [electronjs.org/docs/latest/api/app](https://www.electronjs.org/docs/latest/api/app/)
- Electron `utilityProcess`: [electronjs.org/docs/latest/api/utility-process](https://www.electronjs.org/docs/latest/api/utility-process)
- Tauri system tray: [v2.tauri.app/learn/system-tray](https://v2.tauri.app/learn/system-tray/)
- Tauri external binaries / sidecar: [v2.tauri.app/develop/sidecar](https://v2.tauri.app/develop/sidecar/)
- Tauri Node.js sidecar guide: [v2.tauri.app/learn/sidecar-nodejs](https://v2.tauri.app/learn/sidecar-nodejs/)
- Tauri autostart plugin: [v2.tauri.app/plugin/autostart](https://v2.tauri.app/plugin/autostart/)
