# Implementation Checklist

Build order:

1. Initialize package metadata and TypeScript config.
2. Implement protocol, parser, and guard.
3. Implement workspace sandbox and restricted shell.
4. Implement Playwright ChatGPT bridge with selector resilience and stabilizer.
5. Implement browser tools and self-healing.
6. Implement planner, memory, and main agent loop.
7. Typecheck, install Playwright Chromium, and smoke test.

Acceptance checks:

- Agent can read, write, and list files only inside the sandbox.
- Agent can run approved shell commands.
- Agent can navigate and interact with external pages using browser tools.
- ChatGPT responses are stabilized before parsing.
- Selector failures retry through a self-heal path.
- Planner returns a multi-step plan.
- Loop stops on `FINAL` or iteration limits.

Regression checks:

- Missing or expired storage state.
- Composer selector drift.
- Invalid tool JSON.
- Repeated identical actions.
- Tool errors that should trigger a retry path.
