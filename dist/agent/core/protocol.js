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
        "Each step must name the exact tool to use whenever a tool is required.",
        "Do not include purely mental steps for filesystem, shell, or browser work.",
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
    const recentFacts = input.recentFacts && input.recentFacts.length > 0 ? input.recentFacts.map((item) => `- ${item}`).join("\n") : "None";
    const recentFailures = input.recentFailures && input.recentFailures.length > 0
        ? input.recentFailures.map((item) => `- ${item}`).join("\n")
        : "None";
    return [
        `Main task: ${input.task}`,
        `Current plan step (${input.stepIndex + 1}/${input.totalSteps}): ${input.step}`,
        input.requiredTool
            ? `Required tool for this step: ${input.requiredTool}. You must use ACTION: ${input.requiredTool} successfully before FINAL.`
            : null,
        input.workspaceRoot ? `Workspace root: ${input.workspaceRoot}` : null,
        `Completed step summaries:\n${completed}`,
        `Memory summary:\n${input.memorySummary}`,
        `Recent verified facts:\n${recentFacts}`,
        `Recent failures:\n${recentFailures}`,
        `Latest tool result:\n${lastToolResult}`,
        "Available tools:",
        toolSchemas,
        "Rules:",
        "- Use exactly one ACTION at a time.",
        "- Prefer inspecting state before mutating files.",
        input.requiredTool
            ? `- This step requires ACTION: ${input.requiredTool} before FINAL.`
            : "- If the current step names a tool explicitly, use that tool before FINAL.",
        "- Only return FINAL when the current step is proven complete by successful tool results.",
        "- Never claim a file was created, modified, read, verified, or listed unless a tool result in this task confirms it.",
        "- If a tool failed, report the limitation accurately instead of claiming success.",
        "- Filesystem and shell tools can only access paths inside the workspace root.",
        "- When the current step is complete, respond with FINAL: short step summary.",
        "- Do not include markdown fences or extra commentary."
    ]
        .filter(Boolean)
        .join("\n\n");
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
export function createFinalSynthesisPrompt(input) {
    const lines = input.stepSummaries.map((item, index) => `${index + 1}. ${item}`).join("\n");
    const recentFacts = input.recentFacts && input.recentFacts.length > 0 ? input.recentFacts.map((item) => `- ${item}`).join("\n") : "None";
    const recentFailures = input.recentFailures && input.recentFailures.length > 0
        ? input.recentFailures.map((item) => `- ${item}`).join("\n")
        : "None";
    return [
        `Task: ${input.task}`,
        input.workspaceRoot ? `Workspace root: ${input.workspaceRoot}` : null,
        `Completed step summaries:\n${lines || "None"}`,
        `Verified facts:\n${recentFacts}`,
        `Failures and limits:\n${recentFailures}`,
        "Use only the verified facts and failures above.",
        "Do not claim filesystem or shell side effects unless they were confirmed by a successful tool result.",
        "If the task could not be completed because a requested path was outside the workspace root, say that explicitly.",
        "Return the final answer as:",
        "FINAL: concise result"
    ]
        .filter(Boolean)
        .join("\n\n");
}
export function formatToolResult(result) {
    return JSON.stringify({
        ok: result.ok,
        tool: result.tool,
        summary: result.summary,
        data: result.data
    }, null, 2);
}
