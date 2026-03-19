export class ScriptedReasoningBridge {
    scenario;
    stepTurnCounts = new Map();
    constructor(scenario) {
        this.scenario = scenario;
    }
    async initialize() { }
    async openLoginWindow() {
        throw new Error("ScriptedReasoningBridge does not support login flows.");
    }
    async resetConversation() {
        this.stepTurnCounts.clear();
    }
    async prime(_initialPrompt) { }
    async ask(prompt) {
        if (prompt.startsWith("Create a concise execution plan for the task below.")) {
            return JSON.stringify({ steps: this.scenario.plan });
        }
        if (prompt.startsWith("RESULT:\n") || prompt.startsWith("FORMAT ERROR.") || prompt.startsWith("STEP COMPLETION BLOCKED.")) {
            return "ACK";
        }
        const currentStep = readCurrentStep(prompt);
        if (currentStep) {
            const turns = this.scenario.turnsByStep[currentStep];
            if (!turns) {
                throw new Error(`No scripted turns configured for step: ${currentStep}`);
            }
            const currentTurn = this.stepTurnCounts.get(currentStep) ?? 0;
            const turn = turns[currentTurn];
            if (!turn) {
                throw new Error(`No scripted turn ${currentTurn + 1} configured for step: ${currentStep}`);
            }
            this.stepTurnCounts.set(currentStep, currentTurn + 1);
            return formatTurn(turn);
        }
        if (prompt.startsWith("Task: ") && prompt.includes("Return the final answer as:")) {
            return `FINAL: ${this.scenario.finalResult}`;
        }
        throw new Error(`Unexpected prompt for ScriptedReasoningBridge:\n${prompt}`);
    }
    async close() { }
}
function readCurrentStep(prompt) {
    const match = prompt.match(/Current plan step \(\d+\/\d+\): ([^\n]+)/);
    return match?.[1]?.trim() || null;
}
function formatTurn(turn) {
    if (turn.kind === "final") {
        return `FINAL: ${turn.result}`;
    }
    return [`THOUGHT: ${turn.thought}`, `ACTION: ${turn.action}`, `INPUT: ${JSON.stringify(turn.input)}`].join("\n");
}
