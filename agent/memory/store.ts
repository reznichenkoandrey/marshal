import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ShortTermMemory = {
  activeTask: string | null;
  plan: string[];
  currentStep: string | null;
  lastThought: string | null;
  lastAction: string | null;
  lastToolResult: string | null;
  iteration: number;
  updatedAt: string | null;
};

type LongTermMemory = {
  completedTasks: Array<{
    task: string;
    result: string;
    completedAt: string;
  }>;
  knownFiles: string[];
  pastActions: Array<{
    action: string;
    input: string;
    createdAt: string;
  }>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class MemoryStore {
  shortTermPath: string;
  longTermPath: string;

  constructor(baseDir = __dirname) {
    this.shortTermPath = path.join(baseDir, "short-term.json");
    this.longTermPath = path.join(baseDir, "long-term.json");
  }

  async initialize(): Promise<void> {
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

  async setActiveTask(task: string, plan: string[]): Promise<void> {
    const shortTerm = await this.readShortTerm();
    shortTerm.activeTask = task;
    shortTerm.plan = plan;
    shortTerm.currentStep = plan[0] ?? null;
    shortTerm.iteration = 0;
    shortTerm.updatedAt = new Date().toISOString();
    await this.writeShortTerm(shortTerm);
  }

  async setCurrentStep(step: string, iteration: number): Promise<void> {
    const shortTerm = await this.readShortTerm();
    shortTerm.currentStep = step;
    shortTerm.iteration = iteration;
    shortTerm.updatedAt = new Date().toISOString();
    await this.writeShortTerm(shortTerm);
  }

  async recordAction(thought: string, action: string, input: Record<string, unknown>): Promise<void> {
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

  async recordToolResult(result: string): Promise<void> {
    const shortTerm = await this.readShortTerm();
    shortTerm.lastToolResult = result;
    shortTerm.updatedAt = new Date().toISOString();
    await this.writeShortTerm(shortTerm);
  }

  async rememberFiles(paths: string[]): Promise<void> {
    const longTerm = await this.readLongTerm();
    const known = new Set(longTerm.knownFiles);
    for (const filePath of paths) {
      known.add(filePath);
    }

    longTerm.knownFiles = [...known].sort();
    await this.writeLongTerm(longTerm);
  }

  async completeTask(task: string, result: string): Promise<void> {
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

  async summarize(): Promise<string> {
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

  private async readShortTerm(): Promise<ShortTermMemory> {
    return readJsonFile<ShortTermMemory>(this.shortTermPath);
  }

  private async writeShortTerm(value: ShortTermMemory): Promise<void> {
    await fs.writeFile(this.shortTermPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  }

  private async readLongTerm(): Promise<LongTermMemory> {
    return readJsonFile<LongTermMemory>(this.longTermPath);
  }

  private async writeLongTerm(value: LongTermMemory): Promise<void> {
    await fs.writeFile(this.longTermPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  }
}

async function ensureJsonFile(filePath: string, initialValue: object): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(initialValue, null, 2) + "\n", "utf8");
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}
