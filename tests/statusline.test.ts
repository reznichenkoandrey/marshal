import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  STATUSLINE_SCRIPT_NAME,
  buildUsageWrapper,
  installStatusLine,
  isMarshalStatusLine,
  shellQuote,
  uninstallStatusLine,
  unwrapStatusLine,
  wrapStatusLine
} from "../desktop/claude-code/statusline.ts";

const WRAPPER_COMMAND = `/bin/sh '/x/${STATUSLINE_SCRIPT_NAME}'`;
const userStatusLine = { type: "command", command: "~/.claude/statusline.sh", padding: 2 };

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-statusline-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runWrapper(script: string, stdin: string): Promise<string> {
  const scriptPath = path.join(tempDir(), "wrapper.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = execFile("/bin/sh", [scriptPath], (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin?.end(stdin);
  });
}

describe("statusline settings merge", () => {
  it("wraps a user statusline and keeps other settings", () => {
    const settings = { theme: "dark", statusLine: userStatusLine };
    const next = wrapStatusLine(settings, WRAPPER_COMMAND);
    expect(next.theme).toBe("dark");
    expect(isMarshalStatusLine(next.statusLine)).toBe(true);
  });

  it("is idempotent when already wrapped", () => {
    const wrapped = wrapStatusLine({}, WRAPPER_COMMAND);
    expect(wrapStatusLine(wrapped, `/bin/sh '/other/${STATUSLINE_SCRIPT_NAME}'`)).toBe(wrapped);
  });

  it("restores the exact previous statusline value", () => {
    const wrapped = wrapStatusLine({ theme: "dark", statusLine: userStatusLine }, WRAPPER_COMMAND);
    expect(unwrapStatusLine(wrapped, userStatusLine)).toEqual({ theme: "dark", statusLine: userStatusLine });
  });

  it("removes statusLine when there was none before", () => {
    const wrapped = wrapStatusLine({ theme: "dark" }, WRAPPER_COMMAND);
    expect(unwrapStatusLine(wrapped, null)).toEqual({ theme: "dark" });
  });

  it("leaves a statusline the user replaced after install", () => {
    const replaced = { type: "command", command: "~/new-statusline.sh" };
    expect(unwrapStatusLine({ statusLine: replaced }, userStatusLine)).toEqual({ statusLine: replaced });
  });
});

describe("usage wrapper script", () => {
  it("quotes single quotes in the previous command", () => {
    expect(shellQuote("echo 'a'")).toBe(`'echo '\\''a'\\'''`);
  });

  it("stores the JSON per session and prints the previous statusline output", async () => {
    const usageDir = tempDir();
    const script = buildUsageWrapper(usageDir, "cat | tr a-z A-Z");
    const input = '{"session_id":"abc-123","cost":{"total_cost_usd":0.42}}';
    const out = await runWrapper(script, input);
    expect(out).toBe(input.toUpperCase());
    expect(fs.readFileSync(path.join(usageDir, "abc-123.json"), "utf8")).toBe(input);
  });

  it("prints nothing and still records when there was no previous statusline", async () => {
    const usageDir = tempDir();
    const out = await runWrapper(buildUsageWrapper(usageDir, null), '{"session_id":"s1"}');
    expect(out).toBe("");
    expect(fs.existsSync(path.join(usageDir, "s1.json"))).toBe(true);
  });

  it("skips recording when the input carries no safe session id", async () => {
    const usageDir = tempDir();
    await runWrapper(buildUsageWrapper(usageDir, null), '{"session_id":"../escape"}');
    expect(fs.readdirSync(usageDir)).toEqual([]);
  });
});

describe("install and uninstall on a settings file", () => {
  it("keeps the user's hooks and restores their statusline exactly", () => {
    const root = tempDir();
    const settingsPath = path.join(root, "settings.json");
    const usageDir = path.join(root, "claude-usage");
    const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "~/.claude/hooks/save.sh" }] }] }, statusLine: userStatusLine };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    installStatusLine(usageDir, settingsPath);
    const installed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as typeof original;
    expect(installed.hooks).toEqual(original.hooks);
    expect(isMarshalStatusLine(installed.statusLine)).toBe(true);

    installStatusLine(usageDir, settingsPath);
    expect(fs.readFileSync(path.join(usageDir, "previous-statusline.json"), "utf8")).toBe(JSON.stringify(userStatusLine));

    uninstallStatusLine(usageDir, settingsPath);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual(original);
    expect(fs.existsSync(path.join(usageDir, STATUSLINE_SCRIPT_NAME))).toBe(false);
  });
});
