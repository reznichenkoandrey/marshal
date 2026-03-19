import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export class MemoryStore {
    shortTermPath;
    longTermPath;
    constructor(baseDir = __dirname) {
        this.shortTermPath = path.join(baseDir, "short-term.json");
        this.longTermPath = path.join(baseDir, "long-term.json");
    }
    async initialize() {
        await fs.mkdir(path.dirname(this.shortTermPath), { recursive: true });
        await ensureJsonFile(this.shortTermPath, {
            activeTask: null,
            plan: [],
            currentStep: null,
            lastThought: null,
            lastAction: null,
            lastToolResult: null,
            iteration: 0,
            updatedAt: null
        });
        await ensureJsonFile(this.longTermPath, {
            completedTasks: [],
            knownFiles: [],
            pastActions: []
        });
    }
    async setActiveTask(task, plan) {
        const shortTerm = await this.readShortTerm();
        shortTerm.activeTask = task;
        shortTerm.plan = plan;
        shortTerm.currentStep = plan[0] ?? null;
        shortTerm.iteration = 0;
        shortTerm.updatedAt = new Date().toISOString();
        await this.writeShortTerm(shortTerm);
    }
    async setCurrentStep(step, iteration) {
        const shortTerm = await this.readShortTerm();
        shortTerm.currentStep = step;
        shortTerm.iteration = iteration;
        shortTerm.updatedAt = new Date().toISOString();
        await this.writeShortTerm(shortTerm);
    }
    async recordAction(thought, action, input) {
        const shortTerm = await this.readShortTerm();
        const longTerm = await this.readLongTerm();
        shortTerm.lastThought = thought;
        shortTerm.lastAction = action;
        shortTerm.updatedAt = new Date().toISOString();
        longTerm.pastActions.push({
            action,
            input: JSON.stringify(input),
            createdAt: new Date().toISOString()
        });
        longTerm.pastActions = longTerm.pastActions.slice(-100);
        await Promise.all([this.writeShortTerm(shortTerm), this.writeLongTerm(longTerm)]);
    }
    async recordToolResult(result) {
        const shortTerm = await this.readShortTerm();
        shortTerm.lastToolResult = result;
        shortTerm.updatedAt = new Date().toISOString();
        await this.writeShortTerm(shortTerm);
    }
    async rememberFiles(paths) {
        const longTerm = await this.readLongTerm();
        const known = new Set(longTerm.knownFiles);
        for (const filePath of paths) {
            known.add(filePath);
        }
        longTerm.knownFiles = [...known].sort();
        await this.writeLongTerm(longTerm);
    }
    async completeTask(task, result) {
        const shortTerm = await this.readShortTerm();
        const longTerm = await this.readLongTerm();
        longTerm.completedTasks.push({
            task,
            result,
            completedAt: new Date().toISOString()
        });
        longTerm.completedTasks = longTerm.completedTasks.slice(-25);
        shortTerm.activeTask = null;
        shortTerm.currentStep = null;
        shortTerm.updatedAt = new Date().toISOString();
        await Promise.all([this.writeLongTerm(longTerm), this.writeShortTerm(shortTerm)]);
    }
    async summarize() {
        const shortTerm = await this.readShortTerm();
        const longTerm = await this.readLongTerm();
        const recentTasks = longTerm.completedTasks
            .slice(-3)
            .map((task, index) => `${index + 1}. ${task.task} -> ${task.result}`)
            .join("\n");
        const knownFiles = longTerm.knownFiles.slice(-10).join(", ") || "None";
        return [
            `Active task: ${shortTerm.activeTask ?? "None"}`,
            `Current step: ${shortTerm.currentStep ?? "None"}`,
            `Last action: ${shortTerm.lastAction ?? "None"}`,
            `Known files: ${knownFiles}`,
            `Recent completed tasks:\n${recentTasks || "None"}`
        ].join("\n");
    }
    async readShortTerm() {
        return readJsonFile(this.shortTermPath);
    }
    async writeShortTerm(value) {
        await fs.writeFile(this.shortTermPath, JSON.stringify(value, null, 2) + "\n", "utf8");
    }
    async readLongTerm() {
        return readJsonFile(this.longTermPath);
    }
    async writeLongTerm(value) {
        await fs.writeFile(this.longTermPath, JSON.stringify(value, null, 2) + "\n", "utf8");
    }
}
async function ensureJsonFile(filePath, initialValue) {
    try {
        await fs.access(filePath);
    }
    catch {
        await fs.writeFile(filePath, JSON.stringify(initialValue, null, 2) + "\n", "utf8");
    }
}
async function readJsonFile(filePath) {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
}
