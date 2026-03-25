import fs from "node:fs/promises";
import path from "node:path";

export type FileSandboxOptions = {
  unrestricted?: boolean;
};

export class FileSandbox {
  root: string;
  readonly unrestricted: boolean;

  constructor(
    root = process.env.AGENT_WORKSPACE_ROOT ?? path.resolve(process.cwd(), "agent/workspace"),
    options: FileSandboxOptions = {}
  ) {
    this.root = path.resolve(root);
    this.unrestricted = options.unrestricted ?? false;
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
    // In unrestricted mode, allow absolute paths anywhere on the filesystem
    if (this.unrestricted && path.isAbsolute(relativePath)) {
      return relativePath;
    }

    const absolutePath = path.resolve(this.root, relativePath);
    if (!this.unrestricted && absolutePath !== this.root && !absolutePath.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`Path escapes the sandbox root: ${relativePath}`);
    }

    return absolutePath;
  }

  toRelative(absolutePath: string): string {
    const relativePath = path.relative(this.root, absolutePath);
    return relativePath || ".";
  }
}
