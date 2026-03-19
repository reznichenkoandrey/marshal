import { limits } from "../config/limits.js";
import { createSelectorErrorMessage, createToolErrorMessage } from "../resilience/fallback.js";
import { withRetry } from "../resilience/retry.js";
import { createLoopState, guardAgainstLoop, validateActionPayload } from "./guard.js";
import { parseModelResponse } from "./parser.js";
import { createFinalSynthesisPrompt, createFormatErrorPrompt, createStepPrompt, formatToolResult } from "./protocol.js";
export class AgentLoop {
    bridge;
    memory;
    tools;
    constructor(bridge, memory, tools) {
        this.bridge = bridge;
        this.memory = memory;
        this.tools = tools;
    }
    async runTask(task, planSteps) {
        await this.memory.setActiveTask(task, planSteps);
        const stepSummaries = [];
        let usedIterations = 0;
        for (const [stepIndex, step] of planSteps.entries()) {
            const remainingIterations = limits.maxIterations - usedIterations;
            if (remainingIterations <= 0) {
                throw new Error("Agent loop exhausted the global iteration budget.");
            }
            const result = await this.runStep({
                task,
                step,
                stepIndex,
                totalSteps: planSteps.length,
                stepSummaries,
                maxIterations: remainingIterations
            });
            stepSummaries.push(result.summary);
            usedIterations += result.iterationsUsed;
        }
        const finalResponse = await withRetry(async () => parseModelResponse(await this.bridge.ask(createFinalSynthesisPrompt(task, stepSummaries))), {
            retries: limits.maxRetries,
            initialDelayMs: 500
        });
        const finalResult = finalResponse.kind === "final" ? finalResponse.result : stepSummaries[stepSummaries.length - 1];
        await this.memory.completeTask(task, finalResult);
        return finalResult;
    }
    async runStep(input) {
        const loopState = createLoopState();
        let iteration = 0;
        let lastToolResult = null;
        while (iteration < input.maxIterations) {
            iteration += 1;
            await this.memory.setCurrentStep(input.step, iteration);
            const prompt = createStepPrompt({
                task: input.task,
                step: input.step,
                stepIndex: input.stepIndex,
                totalSteps: input.totalSteps,
                priorStepSummaries: input.stepSummaries,
                lastToolResult,
                memorySummary: await this.memory.summarize()
            });
            const raw = await this.bridge.ask(prompt);
            let parsed;
            try {
                parsed = parseModelResponse(raw);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Unknown parser error.";
                await this.bridge.ask(createFormatErrorPrompt(message));
                continue;
            }
            if (parsed.kind === "final") {
                return {
                    summary: parsed.result,
                    iterationsUsed: iteration
                };
            }
            try {
                validateActionPayload(parsed);
                guardAgainstLoop(parsed, loopState);
                await this.memory.recordAction(parsed.thought, parsed.action, parsed.input);
                const toolResult = await this.tools.execute(parsed.action, parsed.input);
                lastToolResult = formatToolResult(toolResult);
                await this.memory.recordToolResult(lastToolResult);
                await this.learnFiles(toolResult);
                await this.bridge.ask(`RESULT:\n${lastToolResult}`);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Unknown tool error.";
                const fallbackMessage = parsed.action.startsWith("browser_")
                    ? createSelectorErrorMessage(message)
                    : createToolErrorMessage(message);
                lastToolResult = JSON.stringify({ ok: false, error: message }, null, 2);
                await this.memory.recordToolResult(lastToolResult);
                await this.bridge.ask(fallbackMessage);
            }
        }
        throw new Error(`Step exceeded max iterations: ${input.step}`);
    }
    async learnFiles(result) {
        if (result.tool === "read_file" || result.tool === "write_file") {
            const filePath = String(result.data.path ?? "");
            if (filePath) {
                await this.memory.rememberFiles([filePath]);
            }
            return;
        }
        if (result.tool === "list_dir") {
            const basePath = String(result.data.path ?? ".");
            const entries = Array.isArray(result.data.entries) ? result.data.entries.map(String) : [];
            const files = entries.map((entry) => (basePath === "." ? entry : `${basePath}/${entry}`));
            await this.memory.rememberFiles(files);
        }
    }
}
