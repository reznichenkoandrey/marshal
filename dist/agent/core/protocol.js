export const INITIAL_SYSTEM_PROMPT = `You are an autonomous agent.

RULES:
- strict format only
- no extra text
- use tools
- complete tasks step-by-step

RESPONSE FORMAT:
THOUGHT: short reasoning
ACTION: tool_name
INPUT: JSON

OR

FINAL: result`;
export const TOOL_SCHEMAS = [
    'read_file {"path":"relative/path.txt"}',
    'write_file {"path":"relative/path.txt","content":"file contents"}',
    'list_dir {"path":"relative/path"}',
    'run_shell {"cmd":"ls"}',
    'browser_navigate {"url":"https://example.com"}',
    'browser_click {"selector":"text=Docs"}',
    'browser_type {"selector":"placeholder=Search","text":"Playwright"}'
].join("\n");
export function createPlannerPrompt(task) {
    return [
        "Create a concise execution plan for the task below.",
        'Return JSON only in the form {"steps":["step 1","step 2"]}.',
        "Keep steps concrete, sequential, and tool-oriented.",
        `Task: ${task}`
    ].join("\n");
}
export function createStepPrompt(input) {
    const completed = input.priorStepSummaries.length === 0
        ? "None"
        : input.priorStepSummaries.map((item, index) => `${index + 1}. ${item}`).join("\n");
    const lastToolResult = input.lastToolResult ?? "None";
    return [
        `Main task: ${input.task}`,
        `Current plan step (${input.stepIndex + 1}/${input.totalSteps}): ${input.step}`,
        `Completed step summaries:\n${completed}`,
        `Memory summary:\n${input.memorySummary}`,
        `Latest tool result:\n${lastToolResult}`,
        "Available tools:",
        TOOL_SCHEMAS,
        "Rules:",
        "- Use exactly one ACTION at a time.",
        "- Prefer inspecting state before mutating files.",
        "- When the current step is complete, respond with FINAL: short step summary.",
        "- Do not include markdown fences or extra commentary."
    ].join("\n\n");
}
export function createFormatErrorPrompt(error) {
    return [
        "FORMAT ERROR.",
        error,
        "Return exactly one of the following shapes and nothing else:",
        "THOUGHT: short reasoning",
        "ACTION: tool_name",
        "INPUT: JSON",
        "",
        "OR",
        "",
        "FINAL: result"
    ].join("\n");
}
export function createFinalSynthesisPrompt(task, stepSummaries) {
    const lines = stepSummaries.map((item, index) => `${index + 1}. ${item}`).join("\n");
    return [
        `Task: ${task}`,
        `Completed step summaries:\n${lines || "None"}`,
        "Return the final answer as:",
        "FINAL: concise result"
    ].join("\n\n");
}
export function formatToolResult(result) {
    return JSON.stringify({
        ok: result.ok,
        tool: result.tool,
        summary: result.summary,
        data: result.data
    }, null, 2);
}
