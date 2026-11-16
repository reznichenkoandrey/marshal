import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { harborCall, harborRequest, usesHarbor, type HarborRequest } from "../desktop/claude-code/harbor.ts";

const servers: net.Server[] = [];
const dirs: string[] = [];

function socketPath(): string {
  // Unix socket paths stop at 104 bytes on macOS; the vitest tmp dir can be long.
  const dir = fs.mkdtempSync(path.join("/tmp", "mh-"));
  dirs.push(dir);
  return path.join(dir, "c.sock");
}

function fakeHarbor(file: string, answer: (request: HarborRequest) => unknown): Promise<HarborRequest[]> {
  const seen: HarborRequest[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (line: string) => {
      const request = JSON.parse(line.trim()) as HarborRequest;
      seen.push(request);
      socket.write(`${JSON.stringify(answer(request))}\n`);
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(file, () => resolve(seen)));
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Harbor control socket client (#425)", () => {
  it("auto picks Harbor only when it is installed", () => {
    expect(usesHarbor("auto", true)).toBe(true);
    expect(usesHarbor("auto", false)).toBe(false);
    expect(usesHarbor("harbor", false)).toBe(true);
    expect(usesHarbor("terminal", true)).toBe(false);
  });

  it("sends one JSON line and reads one back", async () => {
    const file = socketPath();
    const seen = await fakeHarbor(file, () => ({ ok: true, sessions: [] }));
    expect(await harborRequest({ op: "list" }, file)).toEqual({ ok: true, sessions: [] });
    expect(seen).toEqual([{ op: "list" }]);
  });

  it("starts Harbor when nothing listens, then sends the request", async () => {
    const file = socketPath();
    let launched = 0;
    let seen: Promise<HarborRequest[]> | null = null;
    const reply = await harborCall({ op: "focus", name: "general" }, {
      socketPath: file,
      launch: async () => {
        launched++;
        setTimeout(() => (seen = fakeHarbor(file, () => ({ ok: true }))), 300);
      }
    });
    expect(reply).toEqual({ ok: true });
    expect(launched).toBe(1);
    expect(await seen).toEqual([{ op: "focus", name: "general" }]);
  });

  it("gives up when Harbor never comes up", async () => {
    await expect(harborCall({ op: "list" }, { socketPath: socketPath(), launch: async () => undefined, startTimeoutMs: 300 }))
      .rejects.toThrow(/Harbor did not start/);
  });

  it("does not hang on a socket that never answers", async () => {
    const file = socketPath();
    const server = net.createServer(() => undefined);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(file, resolve));
    await expect(harborRequest({ op: "list" }, file, 200)).rejects.toThrow(/did not answer/);
  });
});
