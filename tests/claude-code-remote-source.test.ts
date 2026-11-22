import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyRemoteError,
  listRemoteSessions,
  MAX_REMOTE_HOSTS,
  parseRemoteHosts,
  parseRemoteOutput,
  REMOTE_LIST_COMMAND,
  remoteGroups,
  RemoteSessionList,
  sshArgs,
  type RemoteHost,
  type SshExec
} from "../desktop/claude-code/remote-source.ts";

const session = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid: 4242,
    sessionId: "8a44c875-4ca4-4e2c-ae1c-db6bb44b2e23",
    cwd: "/home/dev/code/api",
    startedAt: 100,
    kind: "interactive",
    entrypoint: "cli",
    messagingSocketPath: "/tmp/cc-socks/4242.sock",
    name: "deploy fix",
    status: "busy",
    statusUpdatedAt: 200,
    ...overrides
  });

const output = (...files: Array<[number, string]>) =>
  ["home /home/dev", ...files.flatMap(([pid, raw]) => [`file ${pid}`, raw]), ""].join("\n");

const devbox: RemoteHost = { alias: "devbox", roots: ["~/code"] };

describe("parseRemoteHosts", () => {
  it("reads alias and folders, one host per line", () => {
    expect(parseRemoteHosts("devbox: ~/code, /srv/app\n\n mac-mini : ~ \n")).toEqual([
      { alias: "devbox", roots: ["~/code", "/srv/app"] },
      { alias: "mac-mini", roots: ["~"] }
    ]);
  });

  it("drops anything ssh could read as an option, a user or an address", () => {
    const text = [
      "-oProxyCommand=evil: ~/code",
      "root@devbox: ~/code",
      "dev box: ~/code",
      "devbox;rm -rf: ~/code",
      "[::1]: ~/code",
      "$(id): ~/code"
    ].join("\n");
    expect(parseRemoteHosts(text)).toEqual([]);
  });

  it("drops a host without an absolute or home folder: no folders means nothing is listed", () => {
    expect(parseRemoteHosts("devbox\ndevbox:\ndevbox: code, ./x")).toEqual([]);
  });

  it("keeps the first line of a repeated alias and caps the list", () => {
    expect(parseRemoteHosts("a: /one\na: /two")).toEqual([{ alias: "a", roots: ["/one"] }]);
    const many = Array.from({ length: MAX_REMOTE_HOSTS + 3 }, (_, i) => `h${i}: /x`).join("\n");
    expect(parseRemoteHosts(many)).toHaveLength(MAX_REMOTE_HOSTS);
  });
});

describe("sshArgs", () => {
  it("passes the alias as its own argv item after --, with a constant remote command", () => {
    const args = sshArgs("devbox");
    expect(args.slice(-3)).toEqual(["--", "devbox", REMOTE_LIST_COMMAND]);
    expect(REMOTE_LIST_COMMAND).not.toContain("devbox");
  });

  it("never prompts, never accepts a host key, forwards nothing, leaves no master behind", () => {
    const args = sshArgs("devbox").join(" ");
    for (const option of [
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "ClearAllForwardings=yes",
      "ControlMaster=no",
      "PermitLocalCommand=no"
    ]) {
      expect(args).toContain(`-o ${option}`);
    }
    expect(sshArgs("devbox")).toEqual(expect.arrayContaining(["-n", "-T", "-a", "-x"]));
  });

  it("refuses an alias that did not come through the allowlist parser", () => {
    expect(() => sshArgs("-oProxyCommand=x")).toThrow();
    expect(() => sshArgs("a b")).toThrow();
  });

  it("keeps the remote script free of single quotes, so the outer quoting cannot be closed", () => {
    expect(REMOTE_LIST_COMMAND.startsWith("sh -c '")).toBe(true);
    expect(REMOTE_LIST_COMMAND.slice(7, -1)).not.toContain("'");
  });
});

describe("parseRemoteOutput", () => {
  it("lists a session under an allowed folder as name@host, without pid or socket", () => {
    const result = parseRemoteOutput(devbox, output([4242, session()]));
    expect(result).toEqual({
      host: "devbox",
      error: null,
      sessions: [
        {
          host: "devbox",
          sessionId: "8a44c875-4ca4-4e2c-ae1c-db6bb44b2e23",
          name: "deploy fix@devbox",
          cwd: "/home/dev/code/api",
          status: "busy",
          waitingFor: null,
          updatedAt: 200
        }
      ]
    });
  });

  it("drops sessions outside the host's folders, including look-alike prefixes and .. escapes", () => {
    const result = parseRemoteOutput(
      devbox,
      output(
        [1, session({ pid: 1, cwd: "/home/dev/work/client" })],
        [2, session({ pid: 2, cwd: "/home/dev/code-private/x" })],
        [3, session({ pid: 3, cwd: "/home/dev/code/../secrets" })],
        [4, session({ pid: 4, cwd: "code/api" })],
        [5, session({ pid: 5, cwd: "/home/dev/code" })]
      )
    );
    expect(result.sessions.map((s) => s.cwd)).toEqual(["/home/dev/code"]);
  });

  it("does not expand ~ when the host reported no usable home", () => {
    const text = ["home relative", "file 4242", session(), ""].join("\n");
    expect(parseRemoteOutput(devbox, text).sessions).toEqual([]);
    expect(parseRemoteOutput({ alias: "devbox", roots: ["/home/dev/code"] }, text).sessions).toHaveLength(1);
  });

  it("skips background jobs, broken JSON and a pid that does not match the file", () => {
    const result = parseRemoteOutput(
      devbox,
      output([1, session({ pid: 1, kind: "bg" })], [2, "{not json"], [3, session({ pid: 9 })], [4242, session()])
    );
    expect(result.sessions).toHaveLength(1);
  });

  it("strips control characters and @ from a remote name, so it cannot fake another host", () => {
    const result = parseRemoteOutput(devbox, output([4242, session({ name: "x@prod\u001b[31m\nboom" })]));
    expect(result.sessions[0].name).toBe("x prod [31m boom@devbox");
  });

  it("orders newest activity first and keeps waitingFor only for waiting sessions", () => {
    const result = parseRemoteOutput(
      devbox,
      output(
        [1, session({ pid: 1, name: "old", statusUpdatedAt: 10 })],
        [2, session({ pid: 2, name: "new", statusUpdatedAt: 99, status: "waiting", waitingFor: "permission prompt" })]
      )
    );
    expect(result.sessions.map((s) => [s.name, s.waitingFor])).toEqual([
      ["new@devbox", "permission prompt"],
      ["old@devbox", null]
    ]);
  });

  it("reports a format error when the answer is not from the list script", () => {
    expect(parseRemoteOutput(devbox, "Welcome to Ubuntu\n")).toEqual({ host: "devbox", sessions: [], error: "format" });
  });
});

describe("classifyRemoteError", () => {
  it("names the failure without keeping stderr", () => {
    expect(classifyRemoteError({ killed: true })).toBe("timeout");
    expect(classifyRemoteError({ code: 255, stderr: "Host key verification failed.\r\n" })).toBe("host-key");
    expect(classifyRemoteError({ code: 255, stderr: "@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @" })).toBe("host-key");
    expect(classifyRemoteError({ code: 255, stderr: "dev@10.0.0.5: Permission denied (publickey)." })).toBe("auth");
    expect(classifyRemoteError({ code: 255, stderr: "ssh: connect to host x port 22: Connection refused" })).toBe("unreachable");
    expect(classifyRemoteError({ code: "ENOENT" })).toBe("unreachable");
    expect(classifyRemoteError({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })).toBe("format");
  });
});

describe("RemoteSessionList", () => {
  const fakeExec = (answers: Record<string, string | Error>) => {
    const calls: string[][] = [];
    const exec: SshExec = async (_file, args) => {
      calls.push(args);
      const answer = answers[args[args.length - 2]];
      if (answer instanceof Error) throw answer;
      return { stdout: answer, stderr: "" };
    };
    return { exec, calls };
  };

  it("makes no connection while the feature is off or the allowlist is empty", async () => {
    const { exec, calls } = fakeExec({});
    const list = new RemoteSessionList(() => [], { exec });
    await list.refresh();
    expect(calls).toEqual([]);
    expect(list.current()).toEqual([]);
  });

  it("asks every allowed host once per refresh and shares a round between concurrent callers", async () => {
    const { exec, calls } = fakeExec({ devbox: output([4242, session()]), mini: output() });
    const hosts = [devbox, { alias: "mini", roots: ["/srv"] }];
    const list = new RemoteSessionList(() => hosts, { exec, warn: () => {} });
    await Promise.all([list.refresh(), list.refresh()]);
    expect(calls.map((args) => args[args.length - 2])).toEqual(["devbox", "mini"]);
    expect(list.current().map((r) => [r.host, r.sessions.length, r.error])).toEqual([
      ["devbox", 1, null],
      ["mini", 0, null]
    ]);
  });

  it("keeps a failed host as an error and logs only the kind", async () => {
    const failure = Object.assign(new Error("ssh failed"), { code: 255, stderr: "dev@10.0.0.5: Permission denied (publickey)." });
    const { exec } = fakeExec({ devbox: failure });
    const warnings: string[] = [];
    const list = new RemoteSessionList(() => [devbox], { exec, warn: (message) => warnings.push(message) });
    await list.refresh();
    expect(list.current()).toEqual([{ host: "devbox", sessions: [], error: "auth" }]);
    expect(warnings).toEqual(["1 of 1 host(s) did not answer: auth"]);
    expect(warnings.join()).not.toMatch(/devbox|10\.0\.0\.5/u);
  });

  it("forgets the answer when the allowlist changes or after five minutes", async () => {
    const { exec } = fakeExec({ devbox: output([4242, session()]) });
    let hosts = [devbox];
    let now = 1_000;
    const list = new RemoteSessionList(() => hosts, { exec, now: () => now });
    await list.refresh();
    expect(list.current()).toHaveLength(1);
    now += 5 * 60_000 + 1;
    expect(list.current()).toEqual([]);
    now = 1_000;
    hosts = [{ alias: "devbox", roots: ["/elsewhere"] }];
    expect(list.current()).toEqual([]);
    hosts = [];
    expect(list.current()).toEqual([]);
  });
});

describe("remoteGroups", () => {
  it("groups by project and host, marks sessions remote and gives them no local pid", () => {
    const result = parseRemoteOutput(devbox, output([4242, session({ status: "waiting", waitingFor: "input needed" })]));
    expect(remoteGroups([result])).toEqual([
      {
        project: "api · remote devbox",
        sessions: [{ pid: 0, name: "deploy fix@devbox", status: "waiting", waitingFor: "input needed", remote: true }]
      }
    ]);
  });

  it("shows a failed host as a row with the reason, in the interface language", () => {
    const failed = [{ host: "devbox", sessions: [], error: "timeout" as const }];
    expect(remoteGroups(failed)).toEqual([{ project: "devbox · no answer in time", sessions: [] }]);
    expect(remoteGroups(failed, "uk")).toEqual([{ project: "devbox · не відповів вчасно", sessions: [] }]);
  });
});

// The real list script, run by a stub `ssh` that plays the remote shell with a
// fixture home. No host is contacted.
describe.skipIf(process.platform === "win32")("list script through a stub ssh", () => {
  const dirs: string[] = [];
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns only live sessions with a socket, and gets the alias as one argv item", async () => {
    // A short base path: a unix socket path has a ~100 byte limit.
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mrs-")));
    dirs.push(home);
    const sessionsDir = path.join(home, ".claude", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const socketPath = path.join(home, "live.sock");
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const cwd = path.join(home, "code", "api");
    const live = JSON.parse(session({ pid: process.pid, cwd, messagingSocketPath: socketPath })) as object;
    // Pretty-printed on purpose: the script must cope with a multi-line file.
    fs.writeFileSync(path.join(sessionsDir, `${process.pid}.json`), JSON.stringify(live, null, 2));
    const deadPid = 2147483646;
    fs.writeFileSync(path.join(sessionsDir, `${deadPid}.json`), session({ pid: deadPid, cwd, messagingSocketPath: socketPath }));
    fs.writeFileSync(path.join(sessionsDir, "notes.json"), "{}");
    fs.writeFileSync(path.join(sessionsDir, `${process.pid}.abc.key`), "token");

    const argvLog = path.join(home, "argv.log");
    const stub = path.join(home, "ssh");
    fs.writeFileSync(
      stub,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argvLog}"; cmd=$a; done\nHOME="${home}" exec sh -c "$cmd"\n`,
      { mode: 0o755 }
    );

    const result = await listRemoteSessions({ alias: "devbox", roots: ["~/code"] }, { sshPath: stub });
    expect(result.error).toBeNull();
    expect(result.sessions).toEqual([
      expect.objectContaining({ name: "deploy fix@devbox", cwd, status: "busy" })
    ]);
    const argv = fs.readFileSync(argvLog, "utf8").split("\n");
    expect(argv[argv.indexOf("--") + 1]).toBe("devbox");

    // Socket gone: the session is no longer live.
    await new Promise((resolve) => server.close(resolve));
    servers.length = 0;
    fs.rmSync(socketPath, { force: true });
    const after = await listRemoteSessions({ alias: "devbox", roots: ["~/code"] }, { sshPath: stub });
    expect(after).toEqual({ host: "devbox", sessions: [], error: null });
  });

  it("reports a missing ssh binary as unreachable instead of throwing", async () => {
    const result = await listRemoteSessions(devbox, { sshPath: "/nonexistent/ssh" });
    expect(result).toEqual({ host: "devbox", sessions: [], error: "unreachable" });
  });
});
