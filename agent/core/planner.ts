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
    const response = await this.bridge.ask(createPlannerPrompt(task, options));
    return parsePlannerResponse(response);
  }
}
