// tests/whisper-server.test.ts
//
// The resident whisper process (#218). A stand-in for whisper-server — a small
// HTTP server answering GET / and POST /inference the way the real one does —
// is "spawned" through the injectable spawnProcess, so the client, the
// lifecycle and the fallback all run for real, over real HTTP, without the
// 1.5 GB model.

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TranscribeResult, WhisperBackend } from "../desktop/dictation/whisper-backend.ts";
import {
  buildServerArgs,
  findFreePort,
  languageCodeFromName,
  ResidentWhisperBackend,
  WhisperServer,
  WhisperServerUnavailableError
} from "../desktop/dictation/whisper-server.ts";

interface FakeServerControl {
  spawned: number;
  requests: string[];
  /** Stops answering without the process "exiting" — a hung server. */
  goSilent(): void;
  children: FakeChild[];
}

class FakeChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  killed = false;
  constructor(private readonly server: http.Server) {
    super();
  }
  kill(): boolean {
    this.killed = true;
    this.server.closeAllConnections();
    this.server.close(() => this.emit("exit", 0));
    return true;
  }
}

/** A whisper-server stand-in: `text` and `language` are what /inference answers. */
function fakeServer(reply: { text: string; language: string }): {
  control: FakeServerControl;
  spawnProcess: (bin: string, args: string[]) => ChildProcess;
} {
  const control: FakeServerControl = { spawned: 0, requests: [], goSilent: () => undefined, children: [] };
  const spawnProcess = (_bin: string, args: string[]): ChildProcess => {
    control.spawned += 1;
    const port = Number(args[args.indexOf("--port") + 1]);
    let silent = false;
    const server = http.createServer((req, res) => {
      if (silent) {
        req.socket.destroy();
        return;
      }
      if (req.method === "GET" && req.url === "/") {
        res.end("<html>whisper</html>");
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("latin1")));
      req.on("end", () => {
        control.requests.push(body);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ task: "transcribe", language: reply.language, text: `${reply.text}\n`, segments: [] }));
      });
    });
    server.listen(port, "127.0.0.1");
    control.goSilent = () => {
      silent = true;
    };
    const child = new FakeChild(server);
    control.children.push(child);
    return child as unknown as ChildProcess;
  };
  return { control, spawnProcess };
}

class FakeCli implements WhisperBackend {
  calls = 0;
  async transcribe(): Promise<TranscribeResult> {
    this.calls += 1;
    return { text: "from whisper-cli", language: "en" };
  }
}

let dir = "";
let wav = "";
let model = "";
const servers: WhisperServer[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "marshal-whisper-server-"));
  wav = path.join(dir, "clip.wav");
  model = path.join(dir, "ggml-test.bin");
  await fs.writeFile(wav, Buffer.from("RIFF....WAVEfmt fake audio"));
  await fs.writeFile(model, "not a real model");
});

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

function makeServer(spawnProcess: (bin: string, args: string[]) => ChildProcess, extra = {}): WhisperServer {
  // process.execPath stands in for the binary: start() only checks that it exists.
  const server = new WhisperServer({ bin: process.execPath, model, threads: 4, spawnProcess, findPort: findFreePort, ...extra });
  servers.push(server);
  return server;
}

describe("buildServerArgs", () => {
  it("binds to loopback only and skips the per-request language pass", () => {
    const args = buildServerArgs("/models/turbo.bin", 18765, 4);
    expect(args).toEqual(expect.arrayContaining(["--host", "127.0.0.1", "--port", "18765", "-m", "/models/turbo.bin"]));
    expect(args).toContain("--no-language-probabilities");
    expect(args).toContain("--no-timestamps");
  });
});

describe("languageCodeFromName", () => {
  it("maps the server's language names to the codes whisper-cli reported", () => {
    expect(languageCodeFromName("english")).toBe("en");
    expect(languageCodeFromName("Ukrainian")).toBe("uk");
    expect(languageCodeFromName("en")).toBe("en");
    expect(languageCodeFromName("klingon")).toBeUndefined();
    expect(languageCodeFromName(undefined)).toBeUndefined();
  });
});

describe("WhisperServer", () => {
  it("starts once and keeps the model resident across requests", async () => {
    const { control, spawnProcess } = fakeServer({ text: " We move billing to Kafka.", language: "english" });
    const server = makeServer(spawnProcess);

    const first = await server.transcribe(wav, { language: "en" });
    const second = await server.transcribe(wav, { language: "en" });

    expect(first).toEqual({ text: "We move billing to Kafka.", language: "en" });
    expect(second.text).toBe("We move billing to Kafka.");
    expect(control.spawned).toBe(1);
  });

  it("shares one start between concurrent first requests", async () => {
    const { control, spawnProcess } = fakeServer({ text: "ok", language: "english" });
    const server = makeServer(spawnProcess);

    await Promise.all([server.transcribe(wav), server.transcribe(wav), server.transcribe(wav)]);

    expect(control.spawned).toBe(1);
    expect(control.requests).toHaveLength(3);
  });

  it("sends the language, the prompt and the audio with every request", async () => {
    const { control, spawnProcess } = fakeServer({ text: "ok", language: "english" });
    const server = makeServer(spawnProcess);

    await server.transcribe(wav, { language: "uk", prompt: "Kafka, p99, billing-svc" });
    await server.transcribe(wav);

    const [withBoth, bare] = control.requests;
    expect(withBoth).toMatch(/name="language"\r\n\r\nuk/u);
    expect(withBoth).toMatch(/name="prompt"\r\n\r\nKafka, p99, billing-svc/u);
    expect(withBoth).toContain("fake audio");
    // No language given means auto-detect, as whisper-cli's `-l auto` did.
    expect(bare).toMatch(/name="language"\r\n\r\nauto/u);
    expect(bare).not.toContain('name="prompt"');
  });

  it("stops after the idle period and starts again on the next request", async () => {
    const { control, spawnProcess } = fakeServer({ text: "ok", language: "english" });
    const server = makeServer(spawnProcess, { idleStopMs: 50 });

    await server.transcribe(wav);
    // Poll rather than sleep a fixed 150 ms: under a loaded test run the
    // close can take longer, and a fixed sleep made this flaky.
    const deadline = Date.now() + 2_000;
    while (server.isRunning && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(control.children[0].killed).toBe(true);
    expect(server.isRunning).toBe(false);

    await server.transcribe(wav);
    expect(control.spawned).toBe(2);
  });

  it("reports a missing binary as a startup failure", async () => {
    const server = new WhisperServer({ bin: path.join(dir, "no-such-binary"), model, threads: 4 });
    servers.push(server);
    const failure = await server.transcribe(wav).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(WhisperServerUnavailableError);
    expect((failure as WhisperServerUnavailableError).phase).toBe("startup");
  });

  it("reports a server that stopped answering as a request failure and kills it", async () => {
    const { control, spawnProcess } = fakeServer({ text: "ok", language: "english" });
    const server = makeServer(spawnProcess);
    await server.transcribe(wav);

    control.goSilent();
    const failure = await server.transcribe(wav).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(WhisperServerUnavailableError);
    expect((failure as WhisperServerUnavailableError).phase).toBe("request");
    // A hung process must not keep the model's memory.
    expect(control.children[0].killed).toBe(true);
  });
});

describe("ResidentWhisperBackend", () => {
  /** Resolves once the server reports itself running, or fails the test after a second. */
  async function untilRunning(server: WhisperServer): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (!server.isRunning) {
      if (Date.now() > deadline) throw new Error("server never came up");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("never makes a request wait for the server to start", async () => {
    // The first start after an install took 13 s for real; nothing may wait on it.
    const { control, spawnProcess } = fakeServer({ text: "from the server", language: "english" });
    const slowStart = (bin: string, args: string[]): ChildProcess => {
      const child = new FakeChild(http.createServer());
      setTimeout(() => {
        spawnProcess(bin, args);
      }, 300);
      return child as unknown as ChildProcess;
    };
    const server = makeServer(slowStart);
    const cli = new FakeCli();
    const backend = new ResidentWhisperBackend(server, cli);

    const started = Date.now();
    expect((await backend.transcribe(wav)).text).toBe("from whisper-cli");
    expect(Date.now() - started).toBeLessThan(150);

    // Close the stand-in that comes up late, so it cannot leak into other tests.
    await new Promise((resolve) => setTimeout(resolve, 350));
    for (const child of control.children) child.kill();
  });

  it("switches to the server as soon as it is ready", async () => {
    const { control, spawnProcess } = fakeServer({ text: "from the server", language: "english" });
    const server = makeServer(spawnProcess);
    const cli = new FakeCli();
    const backend = new ResidentWhisperBackend(server, cli);

    expect((await backend.transcribe(wav)).text).toBe("from whisper-cli");
    await untilRunning(server);
    expect((await backend.transcribe(wav)).text).toBe("from the server");
    expect((await backend.transcribe(wav)).text).toBe("from the server");
    expect(control.spawned).toBe(1);
    expect(cli.calls).toBe(1);
  });

  it("uses whisper-cli for good when the server cannot start", async () => {
    const cli = new FakeCli();
    const server = new WhisperServer({ bin: path.join(dir, "no-such-binary"), model, threads: 4 });
    servers.push(server);
    const backend = new ResidentWhisperBackend(server, cli);

    await backend.transcribe(wav);
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the failed start settle
    await backend.transcribe(wav);
    await backend.transcribe(wav);

    expect(cli.calls).toBe(3);
    expect(server.isRunning).toBe(false);
  });

  it("falls back for one request when the server goes away, then restarts it", async () => {
    const { control, spawnProcess } = fakeServer({ text: "from the server", language: "english" });
    const server = makeServer(spawnProcess);
    const cli = new FakeCli();
    const backend = new ResidentWhisperBackend(server, cli);

    await backend.transcribe(wav);
    await untilRunning(server);
    expect((await backend.transcribe(wav)).text).toBe("from the server");

    control.goSilent();
    expect((await backend.transcribe(wav)).text).toBe("from whisper-cli");
    // Not disabled for the session: the next request starts a fresh server in the background.
    expect((await backend.transcribe(wav)).text).toBe("from whisper-cli");
    await untilRunning(server);
    expect((await backend.transcribe(wav)).text).toBe("from the server");
    expect(control.spawned).toBe(2);
  });
});

describe("ResidentWhisperBackend.transcribeIfResident (#208)", () => {
  it("skips — and warms up — while the server is not running", async () => {
    const { control, spawnProcess } = fakeServer({ text: "from the server", language: "english" });
    const server = makeServer(spawnProcess);
    const cli = new FakeCli();
    const backend = new ResidentWhisperBackend(server, cli);

    await expect(backend.transcribeIfResident(wav)).resolves.toBeNull();
    // Nothing went to whisper-cli: a partial there would slow the final (#219).
    expect(cli.calls).toBe(0);

    const deadline = Date.now() + 1_000;
    while (!server.isRunning && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(backend.transcribeIfResident(wav)).resolves.toEqual({ text: "from the server", language: "en" });
    expect(control.spawned).toBe(1);
  });

  it("stays skipped when the server cannot start", async () => {
    const cli = new FakeCli();
    const server = new WhisperServer({ bin: path.join(dir, "no-such-binary"), model, threads: 4 });
    servers.push(server);
    const backend = new ResidentWhisperBackend(server, cli);

    await expect(backend.transcribeIfResident(wav)).resolves.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(backend.transcribeIfResident(wav)).resolves.toBeNull();
    expect(cli.calls).toBe(0);
  });
});
