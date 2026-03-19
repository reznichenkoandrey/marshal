import { createPlannerPrompt } from "./protocol.js";
import { parsePlannerResponse } from "./parser.js";
export class Planner {
    bridge;
    constructor(bridge) {
        this.bridge = bridge;
    }
    async createPlan(task) {
        const response = await this.bridge.ask(createPlannerPrompt(task));
        return parsePlannerResponse(response);
    }
}
