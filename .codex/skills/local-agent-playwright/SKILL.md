---
name: local-agent-playwright
description: Use when building, refactoring, debugging, or maintaining a local autonomous agent that uses ChatGPT web UI via Playwright as the reasoning engine, including resilient selectors, response stabilization, strict THOUGHT/ACTION/FINAL parsing, memory, retries, and sandboxed file/shell/browser tools.
---

# Local Autonomous Agent

## Use this skill when

- The task is about a local agent that reasons through the ChatGPT web UI.
- The task involves Playwright selectors, DOM stabilization, retries, or self-healing.
- The task involves agent loops, planners, parsers, guards, memory, or tool execution.

## Workflow

1. Read `references/architecture.md`.
2. Read `references/protocol.md`.
3. Read `references/selector-strategy.md`.
4. Keep file operations inside the workspace sandbox.
5. Build in this order: protocol, parser, guard, tools, bridge, loop, memory, retries.
6. Verify with typecheck plus a headed manual ChatGPT session.

## Rules

- Prefer locator-based Playwright selectors.
- Avoid CSS class selectors unless no other option works.
- Treat streamed ChatGPT output as unstable until text stops changing.
- Keep the action protocol strict: `THOUGHT`, `ACTION`, `INPUT`, `FINAL`.
- Validate tool inputs before execution.
- Block unsafe shell commands and path escapes.
- Store memory inside the repo only.

## When ChatGPT UI changes

- Update selector strategy before touching the loop.
- Re-run stabilization and fallback flows.
- Keep selector logic centralized in bridge/resilience modules.

## Output expectation

- Favor small composable modules.
- Favor explicit retries and clear error surfaces.
- Favor deterministic parsing over heuristic scraping.
