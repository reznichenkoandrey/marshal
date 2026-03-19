import type { ParsedResponse, Plan, ToolName } from "./protocol.ts";

const ACTION_NAMES = new Set<ToolName>([
  "read_file",
  "write_file",
  "list_dir",
  "run_shell",
  "browser_navigate",
  "browser_click",
  "browser_type"
]);

function stripCodeFences(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
}

export function parseModelResponse(raw: string): ParsedResponse {
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
  const inlineActionMatch =
    actionMatch ?? text.match(/^THOUGHT:\s*([\s\S]*?)\s+ACTION:\s*([a-z_]+)\s+INPUT:\s*([\s\S]+)$/);

  if (!inlineActionMatch) {
    throw new Error("Response does not match the strict ACTION or FINAL protocol.");
  }

  const action = inlineActionMatch[2].trim() as ToolName;
  if (!ACTION_NAMES.has(action)) {
    throw new Error(`Unsupported action: ${action}`);
  }

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(stripCodeFences(inlineActionMatch[3]));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error.";
    throw new Error(`INPUT is not valid JSON: ${message}`);
  }

  return {
    kind: "action",
    thought: inlineActionMatch[1].trim(),
    action,
    input,
    raw
  };
}

export function parsePlannerResponse(raw: string): Plan {
  const text = stripCodeFences(raw);

  try {
    const parsed = JSON.parse(text) as { steps?: unknown };
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
  } catch {
    const repairedSteps = parseLoosePlannerSteps(text);
    if (repairedSteps.length > 0) {
      return {
        steps: repairedSteps,
        raw
      };
    }

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

function parseLoosePlannerSteps(text: string): string[] {
  const match = text.match(/"steps"\s*:\s*\[([\s\S]*?)\]\s*}/);
  if (!match) {
    return [];
  }

  const inner = match[1].trim();
  if (!inner) {
    return [];
  }

  return inner
    .split(/"\s*,\s*"/)
    .map((value, index, values) => {
      let normalized = value.trim();
      if (index === 0) {
        normalized = normalized.replace(/^"/, "");
      }
      if (index === values.length - 1) {
        normalized = normalized.replace(/"$/, "");
      }

      return normalized.replace(/\\"/g, "\"").trim();
    })
    .filter((value) => value.length > 0);
}
