// tests/backend-client.test.ts
//
// The UtilityProcess client — the last unchecked box in Phase 2 of #39.
//
// The interesting behaviour here is not the happy path but what happens when
// the child goes away: a pending request must reject rather than hang, and a
// *stale* child's exit must not reject requests that already belong to its
// replacement. That race-guard is the reason `restart()` is safe to call from
// a Settings change while a translation is in flight, and nothing was pinning
// it down.
//
// `utilityProcess.fork` is replaced with an EventEmitter-backed stub, so the
// tests drive the exact message protocol from desktop/backend-types.ts without
// an Electron runtime.

import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopBackendRequest, DesktopBackendResponse } from "../desktop/backend-types.ts";

/** Minimal stand-in for an Electron UtilityProcess. */
class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 4242;
  readonly sent: DesktopBackendRequest[] = [];
  killed = false;
  /** Set by the test to answer every request automatically. */
  autoRespond: ((request: DesktopBackendRequest) => DesktopBackendResponse | null) | null = null;

  postMessage(message: DesktopBackendRequest): void {
    this.sent.push(message);
    const response = this.autoRespond?.(message);
    if (response) queueMicrotask(() => this.emit("message", response));
  }

  kill(): boolean {
    this.killed = true;
    this.pid = undefined;
    return true;
  }

  /** The `ready` handshake the client waits for before sending anything. */
  becomeReady(): void {
    this.emit("message", { kind: "ready" });
  }

  get lastRequest(): DesktopBackendRequest {
    const request = this.sent[this.sent.length - 1];
    if (!request) throw new Error("no request was sent");
    return request;
  }
}

const forked: FakeUtilityProcess[] = [];

vi.mock("electron", () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeUtilityProcess();
      forked.push(child);
      return child;
    }
  }
}));

const { DesktopBackendClient } = await import("../desktop/backend-client.ts");

/** Waits a macrotask, so queued microtask responses have landed. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A client whose first child has completed the ready handshake. */
async function readyClient(): Promise<{
  client: InstanceType<typeof DesktopBackendClient>;
  child: FakeUtilityProcess;
}> {
  const client = new DesktopBackendClient("/fake/backend.js");
  const pending = client.invoke("getHealth");
  await tick();
  const child = forked[forked.length - 1];
  child.becomeReady();
  await tick(); // the ready promise resolves before invoke() posts anything
  child.emit("message", { kind: "success", id: child.lastRequest.id, result: null });
  await pending.catch(() => undefined);
  return { client, child };
}

let clients: Array<{ dispose(): void }> = [];

beforeEach(() => {
  forked.length = 0;
  clients = [];
});

afterEach(() => {
  for (const client of clients) client.dispose();
  vi.useRealTimers();
});

describe("DesktopBackendClient.invoke", () => {
  it("waits for the ready handshake before posting a request", async () => {
    const client = new DesktopBackendClient("/fake/backend.js");
    clients.push(client);

    const pending = client.invoke<string>("getHealth");
    await tick();

    const child = forked[0];
    expect(child.sent).toHaveLength(0); // nothing sent before "ready"

    child.becomeReady();
    await tick();
    expect(child.sent).toHaveLength(1);

    child.emit("message", { kind: "success", id: child.lastRequest.id, result: "ok" });
    await expect(pending).resolves.toBe("ok");
  });

  it("matches a response to its own request", async () => {
    const { client, child } = await readyClient();
    clients.push(client);

    const first = client.invoke<string>("listProjects");
    const second = client.invoke<string>("listSessions");
    await tick();

    const [, firstRequest, secondRequest] = child.sent;
    expect(firstRequest.id).not.toBe(secondRequest.id);

    // Answer out of order — the ids, not the arrival order, decide.
    child.emit("message", { kind: "success", id: secondRequest.id, result: "second" });
    child.emit("message", { kind: "success", id: firstRequest.id, result: "first" });

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("rejects with the backend's message on a failure response", async () => {
    const { client, child } = await readyClient();
    clients.push(client);

    const pending = client.invoke("createProject", "demo");
    await tick();
    child.emit("message", { kind: "failure", id: child.lastRequest.id, error: "project exists" });

    await expect(pending).rejects.toThrow("project exists");
  });

  it("ignores a response whose id is unknown", async () => {
    const { client, child } = await readyClient();
    clients.push(client);

    const pending = client.invoke<string>("getHealth");
    await tick();
    child.emit("message", { kind: "success", id: "not-a-real-id", result: "wrong" });

    const realId = child.lastRequest.id;
    child.emit("message", { kind: "success", id: realId, result: "right" });
    await expect(pending).resolves.toBe("right");
  });

  it("peels a trailing options bag off the params", async () => {
    const { client, child } = await readyClient();
    clients.push(client);

    client.invoke("submitTask", { text: "hi" }, { timeoutMs: 5000 }).catch(() => undefined);
    await tick();

    expect(child.lastRequest.params).toEqual([{ text: "hi" }]);
  });

  it("keeps a trailing object that is not an options bag", async () => {
    const { client, child } = await readyClient();
    clients.push(client);

    client.invoke("submitTask", { text: "hi" }, { route: "api" }).catch(() => undefined);
    await tick();

    expect(child.lastRequest.params).toEqual([{ text: "hi" }, { route: "api" }]);
  });

  it("times out instead of hanging when nothing answers", async () => {
    const { client, child } = await readyClient();
    clients.push(client);

    const pending = client.invoke("getHealth", { timeoutMs: 20 });
    await tick();
    expect(child.sent.length).toBeGreaterThan(1);

    await expect(pending).rejects.toThrow(/timed out after 20ms/u);
  });

  it("stops tracking a timed-out request, so a late answer is harmless", async () => {
    const { client, child } = await readyClient();
    clients.push(client);

    const pending = client.invoke("getHealth", { timeoutMs: 20 });
    await tick();
    const id = child.lastRequest.id;
    await expect(pending).rejects.toThrow(/timed out/u);

    expect(() => child.emit("message", { kind: "success", id, result: "late" })).not.toThrow();
  });
});

describe("DesktopBackendClient lifecycle", () => {
  it("rejects everything in flight when the child exits", async () => {
    const { client, child } = await readyClient();
    clients.push(client);

    const first = client.invoke("getHealth");
    const second = client.invoke("listProjects");
    await tick();

    child.emit("exit", 1);

    await expect(first).rejects.toThrow("Desktop backend exited with code 1.");
    await expect(second).rejects.toThrow("Desktop backend exited with code 1.");
  });

  it("rejects everything in flight on dispose", async () => {
    const { client, child } = await readyClient();

    const pending = client.invoke("getHealth");
    await tick();
    client.dispose();

    await expect(pending).rejects.toThrow("Desktop backend client disposed.");
    expect(child.killed).toBe(true);
  });

  it("forks a fresh child on the next invoke after dispose", async () => {
    const { client } = await readyClient();
    clients.push(client);
    client.dispose();
    expect(forked).toHaveLength(1);

    const pending = client.invoke<string>("getHealth");
    await tick();
    expect(forked).toHaveLength(2);

    const replacement = forked[1];
    replacement.becomeReady();
    await tick();
    replacement.emit("message", { kind: "success", id: replacement.lastRequest.id, result: "fresh" });
    await expect(pending).resolves.toBe("fresh");
  });

  it("restart() resolves once the replacement is ready", async () => {
    const { client } = await readyClient();
    clients.push(client);

    const restarted = client.restart();
    await tick();
    expect(forked).toHaveLength(2);

    forked[1].becomeReady();
    await expect(restarted).resolves.toBeUndefined();
  });

  it("a stale child's exit does not reject the replacement's requests", async () => {
    const { client, child: stale } = await readyClient();
    clients.push(client);

    const restarted = client.restart();
    await tick();
    const replacement = forked[1];
    replacement.becomeReady();
    await restarted;

    const pending = client.invoke<string>("getHealth");
    await tick();

    // The killed child's exit event arrives late, as it does in practice.
    stale.emit("exit", 0);
    replacement.emit("message", { kind: "success", id: replacement.lastRequest.id, result: "alive" });

    await expect(pending).resolves.toBe("alive");
  });

  it("a stale child's message is ignored", async () => {
    const { client, child: stale } = await readyClient();
    clients.push(client);

    const restarted = client.restart();
    await tick();
    const replacement = forked[1];
    replacement.becomeReady();
    await restarted;

    const pending = client.invoke<string>("getHealth");
    await tick();
    const id = replacement.lastRequest.id;

    stale.emit("message", { kind: "success", id, result: "from the dead" });
    replacement.emit("message", { kind: "success", id, result: "from the living" });

    await expect(pending).resolves.toBe("from the living");
  });

  it("disposeAsync waits for the exit event", async () => {
    const { client, child } = await readyClient();

    let settled = false;
    const closing = client.disposeAsync(1000).then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);

    child.emit("exit", 0);
    await closing;
    expect(settled).toBe(true);
  });

  it("disposeAsync gives up after its timeout when no exit arrives", async () => {
    const { client } = await readyClient();

    await expect(client.disposeAsync(20)).resolves.toBeUndefined();
  });

  it("disposeAsync on a client that never forked is a no-op", async () => {
    const client = new DesktopBackendClient("/fake/backend.js");
    await expect(client.disposeAsync(20)).resolves.toBeUndefined();
    expect(forked).toHaveLength(0);
  });
});
