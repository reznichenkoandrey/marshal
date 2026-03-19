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

  async createPlan(task: string): Promise<{ steps: string[]; raw: string }> {
    const response = await this.bridge.ask(createPlannerPrompt(task));
    return parsePlannerResponse(response);
  }
}
