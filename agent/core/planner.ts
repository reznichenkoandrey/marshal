import type { ToolName } from "./protocol.ts";
import { createPlannerPrompt } from "./protocol.ts";
import { parsePlannerResponse } from "./parser.ts";

type PlannerBridge = {
  ask(prompt: string): Promise<string>;
};

export class Planner {
  bridge: PlannerBridge;

  constructor(bridge: PlannerBridge) {
    this.bridge = bridge;
  }

  async createPlan(
    task: string,
    options?: { availableTools?: ToolName[]; routeMode?: string }
  ): Promise<{ steps: string[]; raw: string }> {
    let prompt = createPlannerPrompt(task, options);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.bridge.ask(prompt);
      const parsed = parsePlannerResponse(response);
      if (!containsProtocolMarkers(parsed.steps)) {
        return parsed;
      }

      prompt = [
        createPlannerPrompt(task, options),
        "Your previous response used ACTION/FINAL protocol instead of a JSON plan.",
        'Return JSON only in the exact form {"steps":["step 1","step 2"]}.',
        "Do not return THOUGHT, ACTION, INPUT, or FINAL."
      ].join("\n\n");
    }

    return {
      steps: ["Inspect the workspace", "Complete the task", "Verify the result"],
      raw: "Planner fell back after repeated invalid protocol-shaped responses."
    };
  }
}

function containsProtocolMarkers(steps: string[]): boolean {
  return steps.some((step) => /^(FINAL|THOUGHT|ACTION|INPUT):/i.test(step.trim()));
}
