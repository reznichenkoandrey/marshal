import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { limits } from "../config/limits.js";
import { sanitizeShellCommand } from "../core/guard.js";
const execFileAsync = promisify(execFile);
export class ShellTool {
    cwd;
    constructor(cwd) {
        this.cwd = cwd;
    }
    async run(command) {
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
