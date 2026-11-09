import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OneShotRequest } from "../desktop/claude-code/answer-summary.ts";
import {
  buildRouteRequest,
  createContextRouter,
  parseRouteReply,
  routedNotice
} from "../desktop/claude-code/context-router.ts";
import {
  buildDossierRequest,
  DOSSIER_REFRESH_MS,
  DossierKeeper,
  locateTranscript,
  parseDossierReply,
  parseTranscriptTail,
  shouldRefreshDossier
} from "../desktop/claude-code/dossier.ts";
import type { ClaudeSession } from "../desktop/claude-code/registry.ts";

function session(sessionId: string, name: string, cwd = `/Users/me/htdocs/${name}`): ClaudeSession {
  return {
    pid: 1,
    sessionId,
    name,
    cwd,
    status: "idle",
    waitingFor: null,
    entrypoint: "cli",
    socketPath: `/tmp/cc-socks/${sessionId}.sock`,
    startedAt: 0,
    statusUpdatedAt: null
  };
}

// Line shapes copied from a real Claude Code 2.1.317 transcript, trimmed.
const transcriptLines = [
  { type: "queue-operation", operation: "enqueue", sessionId: "a" },
  {
    type: "user",
    isSidechain: false,
    gitBranch: "feature/cache-tags",
    message: {
      role: "user",
      content: "<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>\n\nFix product cache invalidation (#41)"
    }
  },
  {
    type: "assistant",
    isSidechain: false,
    gitBranch: "feature/cache-tags",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "x" },
        { type: "text", text: "Cache tags are missing on the product block." },
        { type: "tool_use", name: "Bash", input: { command: "grep -rn cache" } }
      ]
    }
  },
  { type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", content: "lots of output" }] } },
  { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } },
  { type: "api-request-blob", sessionId: "a", message: { role: "assistant", content: "not a turn" } },
  { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
  { type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Running the integration tests now." }] } },
  { type: "custom-title", customTitle: "Cache fix", sessionId: "a" }
].map((line) => JSON.stringify(line));

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-ctx-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("dossier refresh policy", () => {
  const entry = { text: "x", builtAt: 1_000_000, sourceMtimeMs: 900_000 };

  it("builds a missing dossier when there is a transcript", () => {
    expect(shouldRefreshDossier(undefined, 5, 10)).toBe(true);
    expect(shouldRefreshDossier(undefined, null, 10)).toBe(false);
  });

  it("does not rebuild when the transcript has not moved, however old the dossier", () => {
    expect(shouldRefreshDossier(entry, 900_000, entry.builtAt + 10 * DOSSIER_REFRESH_MS)).toBe(false);
  });

  it("rebuilds a moved transcript at most every 10 minutes", () => {
    expect(shouldRefreshDossier(entry, 950_000, entry.builtAt + DOSSIER_REFRESH_MS - 1)).toBe(false);
    expect(shouldRefreshDossier(entry, 950_000, entry.builtAt + DOSSIER_REFRESH_MS)).toBe(true);
  });
});

describe("transcript tail", () => {
  it("keeps user prompts and assistant text, drops tools, thinking, subagents and reminders", () => {
    const tail = parseTranscriptTail(transcriptLines.join("\n"), false);
    expect(tail.branch).toBe("feature/cache-tags");
    expect(tail.turns).toEqual([
      { role: "user", text: "Fix product cache invalidation (#41)" },
      { role: "assistant", text: "Cache tags are missing on the product block." },
      { role: "assistant", text: "Running the integration tests now." }
    ]);
  });

  it("drops the cut first line of a tail read from the middle of the file", () => {
    const cut = transcriptLines[1].slice(20);
    const tail = parseTranscriptTail([cut, ...transcriptLines.slice(2)].join("\n"), true);
    expect(tail.turns.map((turn) => turn.text)).not.toContain("Fix product cache invalidation (#41)");
    expect(tail.turns).toHaveLength(2);
  });

  it("puts title, directory, branch and turns into the dossier request", () => {
    const request = buildDossierRequest(session("a", "Cache fix"), parseTranscriptTail(transcriptLines.join("\n"), false));
    expect(request.user).toContain("Session title: Cache fix");
    expect(request.user).toContain("Git branch: feature/cache-tags");
    expect(request.user).toContain("User: Fix product cache invalidation (#41)");
    expect(request.system).toContain("Project:");
  });

  it("keeps at most three non-empty lines of the reply", () => {
    expect(parseDossierReply("Project: shop\n\nFeature: cache\nNow: tests\nextra")).toBe("Project: shop\nFeature: cache\nNow: tests");
    expect(parseDossierReply("  \n")).toBeNull();
    expect(parseDossierReply(null)).toBeNull();
  });
});

describe("DossierKeeper", () => {
  function setup() {
    const projects = tmpDir();
    const cwd = "/Users/me/htdocs/shop_site";
    // Newer Claude Code replaces `_`; older folders kept it — the scan finds either.
    const dir = path.join(projects, "-Users-me-htdocs-shop_site");
    fs.mkdirSync(dir);
    const file = path.join(dir, "a.jsonl");
    fs.writeFileSync(file, transcriptLines.join("\n"));
    let now = 10_000_000;
    const complete = vi.fn(async (_request: OneShotRequest) => "Project: shop\nFeature: cache invalidation\nNow: tests");
    const keeper = new DossierKeeper({
      storePath: path.join(tmpDir(), "claude-code", "dossiers.json"),
      complete,
      projectsDir: projects,
      now: () => now
    });
    return { keeper, complete, file, cwd, projects, advance: (ms: number) => (now += ms) };
  }

  it("finds a transcript whose folder name does not match the encoded cwd", () => {
    const { projects, cwd, file } = setup();
    expect(locateTranscript(projects, cwd, "a")).toBe(file);
    expect(locateTranscript(projects, cwd, "missing")).toBeNull();
  });

  it("builds once, shares a concurrent build, and skips an unchanged transcript", async () => {
    const { keeper, complete, cwd } = setup();
    const s = session("a", "Cache fix", cwd);
    await Promise.all([keeper.refresh(s), keeper.refresh(s)]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await keeper.dossiersFor([s])).get("a")).toContain("cache invalidation");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a moved transcript only after 10 minutes, and persists to disk", async () => {
    const { keeper, complete, cwd, file, advance } = setup();
    const s = session("a", "Cache fix", cwd);
    await keeper.refresh(s);
    fs.appendFileSync(file, "\n" + transcriptLines[7]);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    advance(DOSSIER_REFRESH_MS - 1);
    await keeper.refresh(s);
    expect(complete).toHaveBeenCalledTimes(1);
    advance(1);
    await keeper.refresh(s);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("keeps the old dossier when the model fails", async () => {
    const { keeper, complete, cwd } = setup();
    complete.mockResolvedValueOnce(null);
    const s = session("a", "Cache fix", cwd);
    expect((await keeper.dossiersFor([s])).has("a")).toBe(false);
  });
});

describe("route reply parsing", () => {
  const labels = ["S1", "S2", "S3"];

  it("accepts exactly one known label", () => {
    expect(parseRouteReply("S2", labels)).toEqual({ pick: "S2" });
    expect(parseRouteReply(" s3. ", labels)).toEqual({ pick: "S3" });
  });

  it("never guesses: unknown labels, two labels, prose and no reply are unsure", () => {
    for (const reply of ["S4", "S1 S2", "Probably S2", "", null]) {
      expect(parseRouteReply(reply, labels)).toEqual({ unsure: labels });
    }
  });

  it("narrows an UNSURE reply to the labels it names when there are at least two", () => {
    expect(parseRouteReply("UNSURE S1 S3", labels)).toEqual({ unsure: ["S1", "S3"] });
    expect(parseRouteReply("UNSURE S2", labels)).toEqual({ unsure: labels });
    expect(parseRouteReply("UNSURE", labels)).toEqual({ unsure: labels });
  });
});

describe("context router", () => {
  const sessions = [
    session("id-cache", "shop-hyva"),
    session("id-captions", "marshal"),
    session("id-cv", "portfolio")
  ];
  const dossiers = new Map([
    ["id-cache", "Project: shop\nFeature: product cache invalidation (cache tags)\nNow: running integration tests"],
    ["id-captions", "Project: Marshal\nFeature: live captions overlay\nNow: tuning the VAD"],
    ["id-cv", "Project: portfolio\nFeature: CV page\nNow: editing copy"]
  ]);

  function router(reply: string | null, enabled = true) {
    const complete = vi.fn(async (_request: OneShotRequest) => reply);
    const dossierFn = vi.fn(async () => dossiers);
    return { complete, dossierFn, router: createContextRouter({ enabled: () => enabled, dossiers: dossierFn, complete }) };
  }

  it("returns off without touching the model when the setting is disabled", async () => {
    const { router: r, complete, dossierFn } = router("S1", false);
    expect(await r.route("фікс кешу", sessions)).toEqual({ kind: "off" });
    expect(complete).not.toHaveBeenCalled();
    expect(dossierFn).not.toHaveBeenCalled();
  });

  it("routes a Ukrainian command to the session whose English dossier matches", async () => {
    const { router: r, complete } = router("S1");
    expect(await r.route("фікс кешу, запусти тести", sessions)).toEqual({ kind: "session", sessionId: "id-cache" });
    const request = complete.mock.calls[0][0];
    expect(request.user).toContain("S1: shop-hyva");
    expect(request.user).toContain("product cache invalidation");
    expect(request.user).toContain("Command: фікс кешу, запусти тести");
    expect(request.system).toContain("across languages");
  });

  it("maps unsure labels back to session ids for the picker", async () => {
    const { router: r } = router("UNSURE S1 S2");
    expect(await r.route("run the tests", sessions)).toEqual({ kind: "unsure", candidates: ["id-cache", "id-captions"] });
  });

  it("is unsure across all sessions when the model is unavailable", async () => {
    const { router: r } = router(null);
    expect(await r.route("фікс кешу", sessions)).toEqual({ kind: "unsure", candidates: ["id-cache", "id-captions", "id-cv"] });
  });

  it("still asks the model when dossiers fail, with titles only", async () => {
    const complete = vi.fn(async (_request: OneShotRequest) => "S2");
    const r = createContextRouter({ enabled: () => true, dossiers: async () => { throw new Error("disk"); }, complete });
    expect(await r.route("субтитри", sessions)).toEqual({ kind: "session", sessionId: "id-captions" });
    expect(complete.mock.calls[0][0].user).toContain("Dossier: not available yet");
  });

  it("needs no model call for zero or one session, or an empty command", async () => {
    const { router: r, complete } = router("S1");
    expect(await r.route("x", [])).toEqual({ kind: "unsure", candidates: [] });
    expect(await r.route("x", sessions.slice(0, 1))).toEqual({ kind: "session", sessionId: "id-cache" });
    expect(await r.route("  ", sessions)).toEqual({ kind: "unsure", candidates: ["id-cache", "id-captions", "id-cv"] });
    expect(complete).not.toHaveBeenCalled();
  });

  it("labels sessions in order", () => {
    const request = buildRouteRequest("x", [
      { label: "S1", name: "a", cwd: "/a", dossier: null },
      { label: "S2", name: "b", cwd: "/b", dossier: "Project: b" }
    ]);
    expect(request.user.indexOf("S1: a")).toBeLessThan(request.user.indexOf("S2: b"));
  });
});

describe("routed notice", () => {
  it("names the session and shows the command, trimmed", () => {
    expect(routedNotice("shop-hyva", " фікс кешу ")).toEqual({ title: "Sent to shop-hyva by context", body: "фікс кешу" });
    expect(routedNotice("x", "a".repeat(200)).body).toHaveLength(121);
  });
});
