const ACTION_NAMES = new Set([
    "read_file",
    "write_file",
    "list_dir",
    "run_shell",
    "browser_navigate",
    "browser_click",
    "browser_type"
]);
function stripCodeFences(value) {
    const trimmed = value.trim();
    if (!trimmed.startsWith("```")) {
        return trimmed;
    }
    return trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
}
export function parseModelResponse(raw) {
    const text = raw.trim();
    if (!text) {
        throw new Error("Empty model response.");
    }
    const finalMatch = text.match(/^FINAL:\s*([\s\S]+)$/);
    if (finalMatch) {
        return {
            kind: "final",
            result: finalMatch[1].trim(),
            raw
        };
    }
    const actionMatch = text.match(/^THOUGHT:\s*([^\n]+)\nACTION:\s*([a-z_]+)\nINPUT:\s*([\s\S]+)$/);
    if (!actionMatch) {
        throw new Error("Response does not match the strict ACTION or FINAL protocol.");
    }
    const action = actionMatch[2].trim();
    if (!ACTION_NAMES.has(action)) {
        throw new Error(`Unsupported action: ${action}`);
    }
    let input;
    try {
        input = JSON.parse(stripCodeFences(actionMatch[3]));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown JSON parse error.";
        throw new Error(`INPUT is not valid JSON: ${message}`);
    }
    return {
        kind: "action",
        thought: actionMatch[1].trim(),
        action,
        input,
        raw
    };
}
export function parsePlannerResponse(raw) {
    const text = stripCodeFences(raw);
    try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed.steps)) {
            throw new Error("Missing steps array.");
        }
        const steps = parsed.steps
            .map((value) => String(value).trim())
            .filter((value) => value.length > 0);
        if (steps.length === 0) {
            throw new Error("Planner returned no usable steps.");
        }
        return { steps, raw };
    }
    catch {
        const fallbackSteps = text
            .split("\n")
            .map((line) => line.replace(/^\d+\.\s*/, "").trim())
            .filter((line) => line.length > 0);
        if (fallbackSteps.length === 0) {
            return {
                steps: ["Inspect the workspace", "Complete the task", "Verify the result"],
                raw
            };
        }
        return {
            steps: fallbackSteps.slice(0, 6),
            raw
        };
    }
}
