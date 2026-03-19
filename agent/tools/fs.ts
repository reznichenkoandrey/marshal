import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class FileSandbox {
  root: string;

  constructor(root = process.env.AGENT_WORKSPACE_ROOT ?? path.resolve(__dirname, "../workspace")) {
    this.root = path.resolve(root);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  async readFile(relativePath: string): Promise<{ path: string; content: string }> {
    const absolutePath = this.resolveWithinRoot(relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    return {
      path: this.toRelative(absolutePath),
      content
    };
  }

  async writeFile(relativePath: string, content: string): Promise<{ path: string; bytes: number }> {
    const absolutePath = this.resolveWithinRoot(relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    return {
      path: this.toRelative(absolutePath),
      bytes: Buffer.byteLength(content, "utf8")
    };
  }

  async listDir(relativePath = "."): Promise<{ path: string; entries: string[] }> {
    const absolutePath = this.resolveWithinRoot(relativePath);
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    const entries = dirents
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort((left, right) => left.localeCompare(right));

    return {
      path: this.toRelative(absolutePath),
      entries
    };
  }

  resolveWithinRoot(relativePath: string): string {
    const absolutePath = path.resolve(this.root, relativePath);
    if (absolutePath !== this.root && !absolutePath.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`Path escapes the sandbox root: ${relativePath}`);
    }

    return absolutePath;
  }

  toRelative(absolutePath: string): string {
    const relativePath = path.relative(this.root, absolutePath);
    return relativePath || ".";
  }
}
