import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { limits } from "../config/limits.ts";
import { sanitizeShellCommand } from "../core/guard.ts";

const execFileAsync = promisify(execFile);

export class ShellTool {
  cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async run(command: string): Promise<{ cmd: string; stdout: string; stderr: string }> {
    const safeCommand = sanitizeShellCommand(command);
    const { stdout, stderr } = await execFileAsync("/bin/zsh", ["-lc", safeCommand], {
      cwd: this.cwd,
      timeout: limits.shellTimeoutMs,
      maxBuffer: limits.shellOutputLimit
    });

    return {
      cmd: safeCommand,
      stdout: String(stdout).trim(),
      stderr: String(stderr).trim()
    };
  }
}
