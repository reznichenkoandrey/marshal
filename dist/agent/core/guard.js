import { allowedShellCommands, limits } from "../config/limits.js";
const DANGEROUS_SHELL_PATTERNS = [
    /\bsudo\b/i,
    /\brm\s+-rf\b/i,
    /\bmkfs\b/i,
    /\bdd\b/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\bhalt\b/i,
    /\bpoweroff\b/i,
    /\bchown\b/i,
    /\bchmod\s+777\b/i,
    /(^|[^\w])>(?!\s*&1)/,
    /&&/,
    /\|\|/,
    /;/,
    /`/,
    /\$\(/,
    /\bcurl\b.*\|/i,
    /\bwget\b.*\|/i
];
export function createLoopState() {
    return {
        signatures: new Map()
    };
}
export function validateActionPayload(action) {
    validateToolInput(action.action, action.input);
}
export function validateToolInput(action, input) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("Tool INPUT must be a JSON object.");
    }
    switch (action) {
        case "read_file":
        case "list_dir":
            assertString(input.path, "path");
            break;
        case "write_file":
            assertString(input.path, "path");
            assertString(input.content, "content");
            break;
        case "run_shell":
            assertString(input.cmd, "cmd");
            sanitizeShellCommand(input.cmd);
            break;
        case "browser_navigate":
            assertString(input.url, "url");
            if (!/^https?:\/\//i.test(input.url)) {
                throw new Error("browser_navigate requires an absolute http(s) URL.");
            }
            break;
        case "browser_click":
            assertString(input.selector, "selector");
            break;
        case "browser_type":
            assertString(input.selector, "selector");
            assertString(input.text, "text");
            break;
        default:
            throw new Error(`Unknown tool action: ${action}`);
    }
}
export function sanitizeShellCommand(command) {
    const trimmed = command.trim();
    if (!trimmed) {
        throw new Error("Shell command cannot be empty.");
    }
    for (const pattern of DANGEROUS_SHELL_PATTERNS) {
        if (pattern.test(trimmed)) {
            throw new Error(`Blocked shell command: ${trimmed}`);
        }
    }
    const [binary] = trimmed.split(/\s+/, 1);
    if (!allowedShellCommands.includes(binary)) {
        throw new Error(`Shell command not allowed: ${binary}`);
    }
    return trimmed;
}
export function guardAgainstLoop(action, state) {
    const signature = `${action.action}:${JSON.stringify(action.input)}`;
    const current = state.signatures.get(signature) ?? 0;
    const next = current + 1;
    state.signatures.set(signature, next);
    if (next > limits.maxRetries) {
        throw new Error(`Loop guard blocked repeated action: ${signature}`);
    }
}
function assertString(value, field) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Field "${field}" must be a non-empty string.`);
    }
}
