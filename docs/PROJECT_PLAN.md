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
- [ ] Smoke-test each tool path against the live loop.

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

## Current Exit Criteria

The project is not complete until Phases 3, 4, and 6 are closed with live validation, not only static implementation.
