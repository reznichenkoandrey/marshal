export const ALL_TOOL_NAMES = [
    "read_file",
    "write_file",
    "list_dir",
    "run_shell",
    "browser_navigate",
    "browser_click",
    "browser_type"
];
export const TOOL_SCHEMA_BY_NAME = {
    read_file: 'read_file {"path":"relative/path.txt"}',
    write_file: 'write_file {"path":"relative/path.txt","content":"file contents"}',
    list_dir: 'list_dir {"path":"relative/path"}',
    run_shell: 'run_shell {"cmd":"ls"}',
    browser_navigate: 'browser_navigate {"url":"https://example.com"}',
    browser_click: 'browser_click {"selector":"text=Docs"}',
    browser_type: 'browser_type {"selector":"placeholder=Search","text":"Playwright"}'
};
export function getToolSchemas(availableTools = ALL_TOOL_NAMES) {
    return availableTools.map((toolName) => TOOL_SCHEMA_BY_NAME[toolName]).join("\n");
}
export function createInitialSystemPrompt(availableTools = ALL_TOOL_NAMES) {
    return `You are an autonomous agent.

RULES:
- strict format only
- no extra text
- use tools
- complete tasks step-by-step

AVAILABLE TOOLS:
${getToolSchemas(availableTools)}

RESPONSE FORMAT:
THOUGHT: short reasoning
ACTION: tool_name
INPUT: JSON

OR

FINAL: result`;
}
export const INITIAL_SYSTEM_PROMPT = createInitialSystemPrompt();
export function createPlannerPrompt(task, options) {
    return [
        "Create a concise execution plan for the task below.",
        'Return JSON only in the form {"steps":["step 1","step 2"]}.',
        "Keep steps concrete, sequential, and tool-oriented.",
        options?.routeMode ? `Execution route: ${options.routeMode}.` : null,
        options?.availableTools?.length
            ? `Available tools:\n${getToolSchemas(options.availableTools)}`
            : null,
        `Task: ${task}`
    ]
        .filter(Boolean)
        .join("\n");
}
export function createStepPrompt(input) {
    const completed = input.priorStepSummaries.length === 0
        ? "None"
        : input.priorStepSummaries.map((item, index) => `${index + 1}. ${item}`).join("\n");
    const lastToolResult = input.lastToolResult ?? "None";
    const toolSchemas = getToolSchemas(input.availableTools ?? ALL_TOOL_NAMES);
    return [
        `Main task: ${input.task}`,
        `Current plan step (${input.stepIndex + 1}/${input.totalSteps}): ${input.step}`,
        `Completed step summaries:\n${completed}`,
        `Memory summary:\n${input.memorySummary}`,
        `Latest tool result:\n${lastToolResult}`,
        "Available tools:",
        toolSchemas,
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
