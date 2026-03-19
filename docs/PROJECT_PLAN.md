# Project Plan

## Objective

Build a local autonomous AI agent that uses the ChatGPT web UI as the reasoning engine, executes local tools safely, preserves memory, and recovers from selector and formatting failures. Playwright remains available for browser tools and as a legacy bridge path, while the primary authenticated ChatGPT path may use a local Chrome extension bridge when browser automation is blocked.

## Delivery Rules

Every closed phase must go through the same workflow:

1. Update `docs/PROJECT_STATUS.md`.
2. Mark completed checklist items in this plan.
3. Run verification for the phase.
4. Commit the phase delta.
5. Push the branch.
6. Open a pull request.
7. Merge the pull request.
8. Update the current stage and completed items again if merge changed the state.

## Phases

### Phase 1. Repository Foundation

Goal:
- Bootstrap the repository, TypeScript toolchain, build output, and runtime entrypoint.

Done when:
- `package.json`, `tsconfig.json`, and CLI entrypoints exist.
- Build and typecheck pass locally.
- The repository has a reproducible launch path.

Checklist:
- [x] Initialize Node.js + TypeScript project.
- [x] Add build and typecheck scripts.
- [x] Add runnable entrypoints.
- [x] Add local launch shell script.

### Phase 2. Core Agent Runtime

Goal:
- Implement the strict agent loop, planning, parsing, guardrails, memory, and tool dispatch.

Done when:
- The project can generate a plan, execute tool calls, and stop on `FINAL`.
- Invalid tool payloads and repeated loops are blocked.

Checklist:
- [x] Add protocol types and prompt builders.
- [x] Add strict parser and planner parser.
- [x] Add guard rules for tool inputs and shell commands.
- [x] Add memory persistence.
- [x] Add tool dispatch layer.
- [x] Add main agent loop.

### Phase 3. ChatGPT Bridge Hardening

Goal:
- Make ChatGPT web interaction stable across streaming output and DOM drift.

Done when:
- The bridge restores sessions reliably.
- The composer can be found with resilient locators.
- Streaming responses are stabilized before parsing.
- Selector failures can fall back to self-healing.
- The authenticated ChatGPT session has a live-supported bridge path even if Playwright login is blocked by Cloudflare or Chrome protections.

Checklist:
- [x] Add Playwright ChatGPT bridge.
- [x] Add response stabilizer.
- [x] Add selector cache and fallback strategy.
- [x] Add self-heal ranking logic.
- [x] Capture and fix live selector/auth regressions discovered during smoke tests.
- [x] Add extension-based bridge path for real logged-in Chrome sessions.
- [x] Validate the composer locator against the live ChatGPT UI after login.

### Phase 4. Tooling and Sandbox Validation

Goal:
- Verify filesystem, shell, and browser tools behave safely and inside project limits.

Done when:
- Filesystem access is restricted to `agent/workspace`.
- Shell commands are sanitized.
- Browser tools can navigate, click, and type using recovery logic.

Checklist:
- [x] Add workspace sandbox.
- [x] Add restricted shell runner.
- [x] Add browser tool wrapper.
- [x] Smoke-test each tool path against the live loop.

### Phase 5. Delivery Workflow

Goal:
- Make phase closure explicit and repeatable in-repo.

Done when:
- The project contains a written phase plan.
- The project contains a live status board.
- The repo contains a repeatable phase-close GitHub workflow.

Checklist:
- [x] Add project plan.
- [x] Add project status tracker.
- [x] Add PR template.
- [x] Add phase-close helper script.

### Phase 6. End-to-End Acceptance

Goal:
- Validate the user-facing acceptance criteria against real tasks.

Done when:
- The agent can read and write files.
- The agent can execute allowed shell commands.
- The agent can browse pages.
- The agent can plan and execute multi-step tasks.
- The agent can recover from selector drift and formatting errors.

Checklist:
- [ ] Run a file task end-to-end.
- [ ] Run a shell task end-to-end.
- [ ] Run a browser task end-to-end.
- [ ] Run a multi-step planning task end-to-end.
- [ ] Document remaining defects and follow-up phases if needed.

### Phase 7. Andrii Session Launcher

Goal:
- Make the real Chrome profile `Andrii` the default authenticated ChatGPT workspace for Marshal.

Done when:
- One command starts Marshal login mode.
- Chrome opens `chatgpt.com` in the `Andrii` profile.
- The unpacked extension is injected automatically for that session.
- New ChatGPT projects and history stay inside the `Andrii` profile.

Checklist:
- [x] Add a single startup script for Marshal login mode.
- [x] Resolve the Chrome profile by visible name `Andrii`.
- [x] Open ChatGPT in the real `Andrii` Chrome profile.
- [x] Auto-load the unpacked bridge extension for the session.
- [ ] Validate the launcher end-to-end against the live `Andrii` profile.

### Phase 8. Operator Web Console

Goal:
- Add a separate web interface for chatting with Marshal, sending files, and routing work to local tools or browser automation.

Done when:
- A local web app exists for operator conversations.
- Files can be uploaded from the UI and attached to a task.
- The operator can choose or imply whether work should happen on the local computer or in an internet browser.
- Conversation state is preserved independently from the raw ChatGPT tab UI.

Checklist:
- [x] Define the operator API contract and session model.
- [x] Add a web chat UI with file upload support.
- [x] Add backend task routing to local tools and browser tools.
- [x] Add conversation persistence for operator sessions.
- [ ] Validate a full UI-driven task with file attachment.

### Phase 9. Telegram Control Surface

Goal:
- Add Telegram as a remote control and messaging channel for Marshal.

Done when:
- A Telegram bot can receive messages and files.
- The bot can forward tasks into the same execution pipeline as the web UI.
- Responses, progress updates, and artifacts return to Telegram cleanly.

Checklist:
- [ ] Define Telegram bot webhook or polling runtime.
- [ ] Add Telegram message and file ingestion.
- [ ] Reuse the shared task/session orchestration layer.
- [ ] Add outbound status and result delivery to Telegram.
- [ ] Validate a full Telegram-driven task end-to-end.

### Phase 10. Unified Control Plane

Goal:
- Unify Chrome-profile execution, web UI, and Telegram into one operator-facing system.

Done when:
- Web UI and Telegram share the same task queue and permission model.
- Local computer actions and browser actions can be requested from either channel.
- Session routing is explicit and auditable.

Checklist:
- [ ] Define a shared orchestration layer for all control surfaces.
- [ ] Add task audit log and artifact storage.
- [ ] Add permission gates for local shell, filesystem, and live browser actions.
- [ ] Validate cross-channel continuity between web UI and Telegram.

### Phase 11. macOS Menu Bar App

Goal:
- Add a native-feeling macOS menu bar control surface on top of the existing Marshal runtime.

Done when:
- Marshal can be controlled from a menu bar app without the browser-hosted operator console.
- The app exposes backend and ChatGPT bridge health clearly.
- Sessions, tasks, attachments, and execution logs are usable from the menu bar UI.
- The desktop shell owns lifecycle actions like start, restart, open ChatGPT, and open workspace/logs.

Checklist:
 - [x] Extract transport-neutral operator orchestration from the HTTP server.
 - [x] Preserve structured runtime events for native progress UI.
 - [x] Add a desktop shell scaffold for the menu bar app.
- [ ] Add a native session/task panel with attachments and execution log.
- [ ] Add Chrome and extension bridge lifecycle controls.
- [ ] Package and validate the app on macOS.

## Current Exit Criteria

The project is not complete until Phases 6, 7, 8, 9, 10, and 11 are closed with live validation, not only static implementation.
