# Architecture

Project layout:

- `index.ts`: repo entrypoint, forwards CLI arguments to the agent runtime.
- `agent/index.ts`: composition root that initializes memory, sandbox, bridge, planner, and loop.
- `agent/core/agent-loop.ts`: step-by-step execution loop with strict parsing, tool execution, retries, and stop conditions.
- `agent/core/planner.ts`: asks ChatGPT for a JSON plan.
- `agent/core/parser.ts`: parses strict `THOUGHT/ACTION/INPUT` or `FINAL` responses.
- `agent/core/protocol.ts`: canonical prompts, tool schemas, and shared protocol types.
- `agent/core/guard.ts`: validates tool payloads, sanitizes shell commands, and blocks loops.
- `agent/bridge/chatgpt.ts`: manages Playwright browser session, storage state reuse, prompt sending, and response capture.
- `agent/bridge/selectors.ts`: centralized locator strategies and selector cache.
- `agent/bridge/stabilizer.ts`: streaming-response stabilization by polling until text stops changing.
- `agent/tools/fs.ts`: filesystem sandbox rooted at `agent/workspace`.
- `agent/tools/shell.ts`: restricted shell execution inside the workspace root.
- `agent/tools/browser.ts`: separate browser page for site navigation/click/type tools.
- `agent/tools/index.ts`: single dispatch surface for all tools.
- `agent/resilience/retry.ts`: generic retry with exponential backoff.
- `agent/resilience/self-heal.ts`: selector fallback ranking for broken locators.
- `agent/resilience/fallback.ts`: standardized feedback when tools or selectors fail.
- `agent/memory/store.ts`: short-term and long-term JSON persistence.
- `agent/memory/*.json`: persisted runtime memory.
- `agent/config/limits.ts`: iteration, timeout, retry, and shell limits.

Execution order:

1. Start browser and restore ChatGPT storage state.
2. Prime ChatGPT with system instructions.
3. Ask for a plan.
4. Execute each plan step through the strict action protocol.
5. Persist memory and synthesize a final result.
