import { limits } from "../config/limits.js";
import { createSelectorErrorMessage, createToolErrorMessage } from "../resilience/fallback.js";
import { withRetry } from "../resilience/retry.js";
import { createLoopState, guardAgainstLoop, validateActionPayload } from "./guard.js";
import { parseModelResponse } from "./parser.js";
import { ALL_TOOL_NAMES, createFinalSynthesisPrompt, createFormatErrorPrompt, createStepPrompt, formatToolResult } from "./protocol.js";
export class AgentLoop {
    bridge;
    memory;
    tools;
    availableTools;
    workspaceRoot;
    onEvent;
    verifiedFacts;
    recentFailures;
    constructor(bridge, memory, tools, options) {
        this.bridge = bridge;
        this.memory = memory;
        this.tools = tools;
        this.availableTools = options?.availableTools ?? ALL_TOOL_NAMES;
        this.workspaceRoot = options?.workspaceRoot;
        this.onEvent = options?.onEvent;
        this.verifiedFacts = [];
        this.recentFailures = [];
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
        const finalResponse = await withRetry(async () => parseModelResponse(await this.bridge.ask(createFinalSynthesisPrompt({
            task,
            stepSummaries,
            workspaceRoot: this.workspaceRoot,
            recentFacts: this.verifiedFacts.slice(-6),
            recentFailures: this.recentFailures.slice(-6)
        }))), {
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
        let successfulToolsForStep = 0;
        const requiredTool = inferRequiredToolFromStep(input.step);
        const requiresToolProof = requiredTool !== null || stepRequiresSuccessfulTool(input.step);
        while (iteration < input.maxIterations) {
            iteration += 1;
            await this.memory.setCurrentStep(input.step, iteration);
            await this.emitEvent({
                type: "step_started",
                step: input.step,
                stepIndex: input.stepIndex,
                totalSteps: input.totalSteps,
                iteration
            });
            const prompt = createStepPrompt({
                task: input.task,
                step: input.step,
                stepIndex: input.stepIndex,
                totalSteps: input.totalSteps,
                priorStepSummaries: input.stepSummaries,
                lastToolResult,
                memorySummary: await this.memory.summarize(),
                workspaceRoot: this.workspaceRoot,
                recentFacts: this.verifiedFacts.slice(-6),
                recentFailures: this.recentFailures.slice(-6),
                availableTools: this.availableTools,
                requiredTool
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
                if (requiresToolProof && successfulToolsForStep === 0) {
                    await this.bridge.ask([
                        "STEP COMPLETION BLOCKED.",
                        `The current step requires a successful tool result before FINAL is allowed: ${input.step}`,
                        requiredTool
                            ? `Use exactly one ACTION: ${requiredTool} with valid INPUT JSON, then wait for its RESULT before returning FINAL.`
                            : "Use exactly one ACTION and wait for its RESULT before returning FINAL."
                    ].join("\n"));
                    continue;
                }
                await this.emitEvent({
                    type: "step_completed",
                    step: input.step,
                    stepIndex: input.stepIndex,
                    totalSteps: input.totalSteps,
                    summary: parsed.result
                });
                return {
                    summary: parsed.result,
                    iterationsUsed: iteration
                };
            }
            try {
                validateActionPayload(parsed);
                guardAgainstLoop(parsed, loopState);
                await this.memory.recordAction(parsed.thought, parsed.action, parsed.input);
                await this.emitEvent({
                    type: "action_requested",
                    step: input.step,
                    stepIndex: input.stepIndex,
                    action: parsed.action,
                    thought: parsed.thought,
                    input: parsed.input
                });
                const toolResult = await this.tools.execute(parsed.action, parsed.input);
                lastToolResult = formatToolResult(toolResult);
                successfulToolsForStep += 1;
                this.recordToolSuccess(toolResult);
                await this.memory.recordToolResult(lastToolResult);
                await this.learnFiles(toolResult);
                await this.emitEvent({
                    type: "tool_completed",
                    step: input.step,
                    stepIndex: input.stepIndex,
                    action: parsed.action,
                    summary: toolResult.summary
                });
                await this.bridge.ask(`RESULT:\n${lastToolResult}`);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Unknown tool error.";
                const fallbackMessage = parsed.action.startsWith("browser_")
                    ? createSelectorErrorMessage(message)
                    : createToolErrorMessage(message);
                lastToolResult = JSON.stringify({ ok: false, error: message }, null, 2);
                this.recordToolFailure(parsed.action, message);
                await this.memory.recordToolResult(lastToolResult);
                await this.emitEvent({
                    type: "tool_failed",
                    step: input.step,
                    stepIndex: input.stepIndex,
                    action: parsed.action,
                    error: message
                });
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
    async emitEvent(event) {
        await this.onEvent?.(event);
    }
    recordToolSuccess(result) {
        const detail = this.describeToolOutcome(result.tool, result.data, result.summary);
        this.verifiedFacts.push(detail);
        if (this.verifiedFacts.length > 20) {
            this.verifiedFacts.shift();
        }
    }
    recordToolFailure(action, error) {
        this.recentFailures.push(`${action} failed: ${error}`);
        if (this.recentFailures.length > 20) {
            this.recentFailures.shift();
        }
    }
    describeToolOutcome(tool, data, summary) {
        if (tool === "write_file") {
            const filePath = String(data.path ?? "");
            const bytes = Number(data.bytes ?? 0);
            return `write_file succeeded for ${filePath || "unknown path"} (${bytes} bytes)`;
        }
        if (tool === "read_file") {
            const filePath = String(data.path ?? "");
            return `read_file succeeded for ${filePath || "unknown path"}`;
        }
        if (tool === "list_dir") {
            const dirPath = String(data.path ?? ".");
            const entries = Array.isArray(data.entries) ? data.entries.length : 0;
            return `list_dir succeeded for ${dirPath} (${entries} entries)`;
        }
        if (tool === "run_shell") {
            const cmd = String(data.cmd ?? "");
            const exitCode = Number(data.exitCode ?? 0);
            return `run_shell succeeded for "${cmd}" (exit ${exitCode})`;
        }
        if (tool === "browser_navigate") {
            return `browser_navigate succeeded for ${String(data.url ?? "")}`;
        }
        if (tool === "browser_click" || tool === "browser_type") {
            return `${tool} succeeded for selector ${String(data.selector ?? "")}`;
        }
        return summary;
    }
}
function stepRequiresSuccessfulTool(step) {
    const normalized = step.trim().toLowerCase();
    if (!normalized) {
        return false;
    }
    if (ALL_TOOL_NAMES.some((toolName) => normalized.includes(toolName))) {
        return true;
    }
    return /(^|[\s"'])https?:\/\//.test(normalized) || /(^|[\s"'(])\/[^\s]*/.test(normalized);
}
function inferRequiredToolFromStep(step) {
    const normalized = step.trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    return ALL_TOOL_NAMES.find((toolName) => normalized.includes(toolName)) ?? null;
}
