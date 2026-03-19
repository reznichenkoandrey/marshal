# Protocol

Strict loop response shapes:

`THOUGHT: short reasoning`
`ACTION: tool_name`
`INPUT: JSON`

or

`FINAL: result`

Parser rules:

- Reject extra prose before or after the protocol.
- Reject unknown tool names.
- Reject invalid JSON.
- On parse failure, send a format-error correction prompt and retry.

Guard rules:

- Validate every tool payload before execution.
- Restrict shell commands to a small allowlist plus denylist.
- Prevent repeated identical actions beyond the retry threshold.
- Reject filesystem paths that escape the sandbox root.

Loop rules:

- Global `maxIterations = 12`.
- Per failure path `maxRetries = 3`.
- Tool errors must be returned to ChatGPT so it can adapt.
- Step completion is represented with `FINAL:` for the current step.
- After all steps, ask ChatGPT for one final synthesis.
