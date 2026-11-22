import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { addMarshalHooks } from "../desktop/claude-code/hook-installer.ts";
import {
  addRemoteHooks,
  drainRemoteHookEvents,
  installRemoteHooks,
  parseDrainOutput,
  readRemoteHookState,
  REMOTE_DRAIN_COMMAND,
  REMOTE_HOOK_COMMAND,
  REMOTE_HOOK_SCRIPT,
  REMOTE_HOOK_SCRIPT_HASH,
  REMOTE_HOOK_SCRIPT_NAME,
  REMOTE_PREPARE_COMMAND,
  REMOTE_PUT_SCRIPT_COMMAND,
  REMOTE_PUT_SETTINGS_COMMAND,
  REMOTE_REMOVE_COMMAND,
  remoteHooksOutdated,
  removeRemoteHooks,
  uninstallRemoteHooks,
  type SshRun
} from "../desktop/claude-code/remote-hooks.ts";
import { sshArgs } from "../desktop/claude-code/remote-source.ts";

const devbox = { alias: "devbox", roots: ["/home/dev/code"] };
const COMMANDS = [
  REMOTE_PREPARE_COMMAND,
  REMOTE_PUT_SCRIPT_COMMAND,
  REMOTE_PUT_SETTINGS_COMMAND,
  REMOTE_REMOVE_COMMAND,
  REMOTE_DRAIN_COMMAND
];

const dirs: string[] = [];
const tmpDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mrh-")));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("remote commands", () => {
  it("are constants a remote shell can take inside one pair of single quotes", () => {
    for (const command of COMMANDS) {
      expect(command.startsWith("sh -c '") && command.endsWith("'")).toBe(true);
      expect(command.slice(7, -1)).not.toContain("'");
    }
  });

  it("keep stdin closed unless a file is sent, and put the command after the alias", () => {
    const read = sshArgs("devbox", REMOTE_PREPARE_COMMAND);
    expect(read).toContain("-n");
    expect(read.slice(-3)).toEqual(["--", "devbox", REMOTE_PREPARE_COMMAND]);
    const write = sshArgs("devbox", REMOTE_PUT_SCRIPT_COMMAND, true);
    expect(write).not.toContain("-n");
    for (const option of ["BatchMode=yes", "StrictHostKeyChecking=yes", "ClearAllForwardings=yes", "ControlMaster=no"]) {
      expect(write).toContain(option);
    }
    expect(() => sshArgs("-oProxyCommand=x", REMOTE_REMOVE_COMMAND, true)).toThrow();
  });
});

describe("addRemoteHooks / removeRemoteHooks", () => {
  const own = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }, model: "opus" };

  it("adds Stop and Notification only, async, with a command that holds no host data", () => {
    const next = addRemoteHooks(own) as { hooks: Record<string, unknown[]>; model: string };
    expect(Object.keys(next.hooks).sort()).toEqual(["Notification", "Stop"]);
    expect(next.hooks.Stop).toHaveLength(2);
    expect(next.hooks.Notification).toEqual([
      { hooks: [{ type: "command", command: REMOTE_HOOK_COMMAND, async: true }] }
    ]);
    expect(next.model).toBe("opus");
    expect(addRemoteHooks(next)).toEqual(next);
  });

  it("removes only its own entries, leaving the owner's and a local Marshal's hooks", () => {
    const withLocal = addMarshalHooks(own, "/bin/sh '/x/marshal-claude-hook.sh'");
    expect(removeRemoteHooks(addRemoteHooks(withLocal))).toEqual(withLocal);
    expect(removeRemoteHooks(addRemoteHooks({}))).toEqual({});
  });
});

describe("parseDrainOutput", () => {
  const record = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ e: "Stop", s: "abc-123", c: "/home/dev/code/api", n: "", t: 1000, ...over });
  const out = (...records: string[]): string =>
    ["home /home/dev", "now 1060", ...records.flatMap((r) => ["event", r]), ""].join("\n");

  it("returns stop and attention events with their age by the host's clock", () => {
    const events = parseDrainOutput(devbox, out(record(), record({ e: "Notification", n: "permission_prompt", t: 1050 })));
    expect(events).toEqual([
      { host: "devbox", ageMs: 60_000, event: { type: "stop", sessionId: "abc-123", cwd: "/home/dev/code/api", lastMessage: "" } },
      {
        host: "devbox",
        ageMs: 10_000,
        event: { type: "attention", sessionId: "abc-123", cwd: "/home/dev/code/api", reason: "confirmation", message: "" }
      }
    ]);
  });

  it("drops what is outside the allowed folders, too old, from the future or malformed", () => {
    const events = parseDrainOutput(
      devbox,
      out(
        record({ c: "/home/dev/private" }),
        record({ c: "/home/dev/code/../private" }),
        record({ t: 1060 - 16 * 60 }),
        record({ t: 2000 }),
        record({ s: "bad id; rm" }),
        record({ e: "Notification", n: "idle_prompt" }),
        record({ t: "1000" }),
        "{not json",
        "null"
      )
    );
    expect(events).toEqual([]);
  });

  it("returns nothing without the host's clock", () => {
    expect(parseDrainOutput(devbox, ["home /home/dev", "event", record(), ""].join("\n"))).toEqual([]);
  });

  it("resolves ~ folders against the home the host reported", () => {
    const host = { alias: "devbox", roots: ["~/code"] };
    expect(parseDrainOutput(host, out(record()))).toHaveLength(1);
    expect(parseDrainOutput(host, out(record()).replace("home /home/dev", "home /root"))).toEqual([]);
  });
});

describe("install / uninstall / drain against a fake run", () => {
  const fakeRun = (answers: Partial<Record<string, string | Error>>) => {
    const calls: Array<{ command: string; alias: string; input?: string }> = [];
    const run: SshRun = async (_file, args, options) => {
      const command = args[args.length - 1];
      calls.push({ command, alias: args[args.length - 2], input: options.input });
      const answer = answers[command] ?? "marshal ok\n";
      if (answer instanceof Error) throw answer;
      return { stdout: answer, stderr: "" };
    };
    return { run, calls };
  };

  it("does not connect to drain a host whose hooks were never installed", async () => {
    const { run, calls } = fakeRun({});
    const statePath = path.join(tmpDir(), "remote-hooks.json");
    expect(await drainRemoteHookEvents(devbox, { run, statePath })).toEqual({ events: [], error: null });
    expect(calls).toEqual([]);
  });

  it("installs script before settings, prefixes each file with its byte count and records the hash", async () => {
    const { run, calls } = fakeRun({ [REMOTE_PREPARE_COMMAND]: 'Welcome!\nmarshal settings\n{\n\t"model": "opus"\n}\n' });
    const statePath = path.join(tmpDir(), "remote-hooks.json");
    expect(await installRemoteHooks(devbox, { run, statePath, now: () => 42 })).toEqual({ ok: true });
    expect(calls.map((call) => call.command)).toEqual([
      REMOTE_PREPARE_COMMAND,
      REMOTE_PUT_SCRIPT_COMMAND,
      REMOTE_PUT_SETTINGS_COMMAND
    ]);
    expect(calls.every((call) => call.alias === "devbox")).toBe(true);
    expect(calls[1].input).toBe(`${Buffer.byteLength(REMOTE_HOOK_SCRIPT)}\n${REMOTE_HOOK_SCRIPT}`);
    const [count, ...body] = (calls[2].input ?? "").split("\n");
    expect(Number(count)).toBe(Buffer.byteLength(body.join("\n")));
    // The owner's indent survives.
    expect(body[1]).toBe('\t"model": "opus",');
    expect(readRemoteHookState(statePath)).toEqual({ devbox: { hash: REMOTE_HOOK_SCRIPT_HASH, installedAt: 42 } });
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    expect(remoteHooksOutdated(readRemoteHookState(statePath), "devbox")).toBe(false);
    expect(remoteHooksOutdated({ devbox: { hash: "old", installedAt: 1 } }, "devbox")).toBe(true);
    expect(remoteHooksOutdated({}, "devbox")).toBe(false);
  });

  it.each([
    ["a symlinked settings.json", "marshal symlink\n", "symlink", [REMOTE_PREPARE_COMMAND]],
    ["settings.json that does not parse", "marshal settings\n{oops", "settings", [REMOTE_PREPARE_COMMAND, REMOTE_REMOVE_COMMAND]],
    ["settings.json that is not an object", "marshal settings\n[]", "settings", [REMOTE_PREPARE_COMMAND, REMOTE_REMOVE_COMMAND]],
    ["an answer that is not the script's", "Last login: today\n", "format", [REMOTE_PREPARE_COMMAND, REMOTE_REMOVE_COMMAND]]
  ])("writes nothing for %s", async (_name, prepared, error, commands) => {
    const { run, calls } = fakeRun({ [REMOTE_PREPARE_COMMAND]: prepared });
    const statePath = path.join(tmpDir(), "remote-hooks.json");
    expect(await installRemoteHooks(devbox, { run, statePath })).toEqual({ ok: false, error });
    expect(calls.map((call) => call.command)).toEqual(commands);
    expect(calls.some((call) => call.input !== undefined)).toBe(false);
    expect(readRemoteHookState(statePath)).toEqual({});
  });

  it("cleans up a first install whose settings changed underneath it and records nothing", async () => {
    const { run, calls } = fakeRun({
      [REMOTE_PREPARE_COMMAND]: "marshal absent\n",
      [REMOTE_PUT_SETTINGS_COMMAND]: "marshal changed\n"
    });
    const statePath = path.join(tmpDir(), "remote-hooks.json");
    expect(await installRemoteHooks(devbox, { run, statePath })).toEqual({ ok: false, error: "changed" });
    expect(calls[calls.length - 1].command).toBe(REMOTE_REMOVE_COMMAND);
    expect(readRemoteHookState(statePath)).toEqual({});
  });

  it("does not remove the script when the host's settings already point at it", async () => {
    const { run, calls } = fakeRun({
      [REMOTE_PREPARE_COMMAND]: `marshal settings\n${JSON.stringify(addRemoteHooks({}))}`,
      [REMOTE_PUT_SCRIPT_COMMAND]: "marshal truncated\n"
    });
    const statePath = path.join(tmpDir(), "remote-hooks.json");
    expect(await installRemoteHooks(devbox, { run, statePath })).toEqual({ ok: false, error: "truncated" });
    expect(calls.map((call) => call.command)).not.toContain(REMOTE_REMOVE_COMMAND);
  });

  it("reports an ssh failure by kind", async () => {
    const failure = Object.assign(new Error("ssh"), { code: 255, stderr: "Host key verification failed." });
    const { run } = fakeRun({ [REMOTE_PREPARE_COMMAND]: failure });
    const statePath = path.join(tmpDir(), "remote-hooks.json");
    expect(await installRemoteHooks(devbox, { run, statePath })).toEqual({ ok: false, error: "host-key" });
    expect(await uninstallRemoteHooks("devbox", { run, statePath })).toEqual({ ok: false, error: "host-key" });
  });

  it("uninstall keeps the script while settings.json cannot be cleaned", async () => {
    const { run, calls } = fakeRun({ [REMOTE_PREPARE_COMMAND]: "marshal settings\n{oops" });
    const statePath = path.join(tmpDir(), "remote-hooks.json");
    expect(await uninstallRemoteHooks("devbox", { run, statePath })).toEqual({ ok: false, error: "settings" });
    expect(calls.map((call) => call.command)).toEqual([REMOTE_PREPARE_COMMAND]);
  });
});

// The real commands and the real hook script, run by a stub `ssh` that plays
// the remote shell with a fixture home. No host is contacted.
describe.skipIf(process.platform === "win32")("round trip through a stub ssh", () => {
  const setup = () => {
    const home = tmpDir();
    const stub = path.join(home, "ssh");
    fs.writeFileSync(stub, `#!/bin/sh\nfor a in "$@"; do cmd=$a; done\nHOME="${home}" exec sh -c "$cmd"\n`, { mode: 0o755 });
    const claude = path.join(home, ".claude");
    fs.mkdirSync(claude);
    return {
      home,
      settingsPath: path.join(claude, "settings.json"),
      remoteDir: path.join(claude, "marshal-remote"),
      host: { alias: "devbox", roots: ["~/code"] },
      deps: { sshPath: stub, statePath: path.join(home, "state", "remote-hooks.json") }
    };
  };
  const fire = (home: string, payload: object): void => {
    execFileSync("/bin/sh", ["-c", REMOTE_HOOK_COMMAND], { input: JSON.stringify(payload), env: { ...process.env, HOME: home } });
  };

  it("installs, spools an event without the conversation text, drains it once and uninstalls cleanly", async () => {
    const { home, settingsPath, remoteDir, host, deps } = setup();
    const own = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } };
    fs.writeFileSync(settingsPath, `${JSON.stringify(own, null, 4)}\n`, { mode: 0o644 });

    expect(await installRemoteHooks(host, deps)).toEqual({ ok: true });
    const installed = fs.readFileSync(settingsPath, "utf8");
    expect(JSON.parse(installed)).toEqual(addRemoteHooks(own));
    expect(installed.startsWith('{\n    "model"')).toBe(true);
    const scriptPath = path.join(remoteDir, REMOTE_HOOK_SCRIPT_NAME);
    expect(fs.readFileSync(scriptPath, "utf8")).toBe(REMOTE_HOOK_SCRIPT);
    expect(fs.statSync(scriptPath).mode & 0o077).toBe(0);
    expect(fs.existsSync(path.join(remoteDir, "settings.before"))).toBe(false);

    const cwd = path.join(home, "code", "api");
    fire(home, {
      session_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
      transcript_path: "/x/t.jsonl",
      cwd,
      hook_event_name: "Stop",
      last_assistant_message: 'secret plan \\"session_id\\":\\"spoof\\" done'
    });
    fire(home, { session_id: "other", cwd: path.join(home, "private"), hook_event_name: "Stop" });
    fire(home, { cwd, hook_event_name: "Stop" });
    const spool = path.join(remoteDir, "spool");
    const spooled = fs.readdirSync(spool).map((name) => fs.readFileSync(path.join(spool, name), "utf8")).join("");
    expect(spooled).not.toMatch(/secret|spoof|transcript/u);

    const drained = await drainRemoteHookEvents(host, deps);
    expect(drained.error).toBeNull();
    expect(drained.events).toEqual([
      {
        host: "devbox",
        ageMs: expect.any(Number),
        event: { type: "stop", sessionId: "0f8fad5b-d9cb-469f-a165-70867728950e", cwd, lastMessage: "" }
      }
    ]);
    expect(fs.readdirSync(spool)).toEqual([]);
    expect((await drainRemoteHookEvents(host, deps)).events).toEqual([]);

    expect(await uninstallRemoteHooks("devbox", deps)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual(own);
    expect(fs.existsSync(remoteDir)).toBe(false);
    expect(readRemoteHookState(deps.statePath)).toEqual({});
  });

  it("creates settings.json when the host has none, and uninstall leaves an empty object", async () => {
    const { settingsPath, remoteDir, host, deps } = setup();
    expect(await installRemoteHooks(host, deps)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual(addRemoteHooks({}));
    expect(await uninstallRemoteHooks("devbox", deps)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({});
    expect(fs.existsSync(remoteDir)).toBe(false);
  });

  it("refuses a symlinked settings.json and leaves the host untouched", async () => {
    const { home, settingsPath, remoteDir, host, deps } = setup();
    const target = path.join(home, "dotfiles-settings.json");
    fs.writeFileSync(target, "{}\n");
    fs.symlinkSync(target, settingsPath);
    expect(await installRemoteHooks(host, deps)).toEqual({ ok: false, error: "symlink" });
    expect(fs.readFileSync(target, "utf8")).toBe("{}\n");
    expect(fs.existsSync(remoteDir)).toBe(false);
  });

  it("does not overwrite settings.json that changed after it was read", async () => {
    const { settingsPath, remoteDir, host, deps } = setup();
    fs.writeFileSync(settingsPath, "{}\n");
    const { default: childProcess } = await import("node:child_process");
    const run: SshRun = (file, args, { input, ...options }) =>
      new Promise((resolve, reject) => {
        // The owner's Claude Code rewrites the file between Marshal's read and write.
        if (args[args.length - 1] === REMOTE_PUT_SETTINGS_COMMAND) fs.writeFileSync(settingsPath, '{"model":"haiku"}\n');
        const child = childProcess.execFile(file, args, options, (err, stdout, stderr) =>
          err ? reject(err) : resolve({ stdout, stderr })
        );
        child.stdin?.end(input ?? "");
      });
    expect(await installRemoteHooks(host, { ...deps, run })).toEqual({ ok: false, error: "changed" });
    expect(fs.readFileSync(settingsPath, "utf8")).toBe('{"model":"haiku"}\n');
    expect(fs.existsSync(remoteDir)).toBe(false);
  });

  it("rejects a file that arrived shorter than announced", async () => {
    const { settingsPath, remoteDir, host, deps } = setup();
    fs.writeFileSync(settingsPath, "{}\n");
    const { default: childProcess } = await import("node:child_process");
    const run: SshRun = (file, args, { input, ...options }) =>
      new Promise((resolve, reject) => {
        const child = childProcess.execFile(file, args, options, (err, stdout, stderr) =>
          err ? reject(err) : resolve({ stdout, stderr })
        );
        const cut = args[args.length - 1] === REMOTE_PUT_SETTINGS_COMMAND ? (input ?? "").slice(0, -5) : input ?? "";
        child.stdin?.end(cut);
      });
    expect(await installRemoteHooks(host, { ...deps, run })).toEqual({ ok: false, error: "truncated" });
    expect(fs.readFileSync(settingsPath, "utf8")).toBe("{}\n");
    expect(fs.existsSync(remoteDir)).toBe(false);
  });
});
