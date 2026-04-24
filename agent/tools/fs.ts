import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Formats where `fs.readFile(... "utf8")` returns binary garbage instead of
// text. macOS ships `textutil`, which converts any of these to plain text
// without extra deps. If textutil fails (not macOS, unknown format, corrupted
// file) we fall back to the raw utf8 read so callers still get *something*.
const RICH_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".docx",
  ".doc",
  ".rtf",
  ".rtfd",
  ".pages",
  ".odt"
]);

const MAX_EXTRACT_BYTES = 16 * 1024 * 1024;

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
    const content = await readWithExtraction(absolutePath);
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

/**
 * Read a file as plain text, auto-extracting rich-text binary formats
 * (.docx/.doc/.rtf/.pages/.odt) via `textutil` on macOS. Exported for tests.
 */
export async function readWithExtraction(absolutePath: string): Promise<string> {
  const ext = path.extname(absolutePath).toLowerCase();
  if (RICH_TEXT_EXTENSIONS.has(ext) && process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "textutil",
        ["-convert", "txt", "-stdout", absolutePath],
        { maxBuffer: MAX_EXTRACT_BYTES, encoding: "utf8" }
      );
      const text = stdout.trim();
      if (text.length > 0) return stdout;
    } catch {
      // textutil may be missing, the file may be corrupted, or the format
      // may not be supported — fall back to the raw utf8 read so the caller
      // at least sees bytes instead of throwing.
    }
  }
  return fs.readFile(absolutePath, "utf8");
}
