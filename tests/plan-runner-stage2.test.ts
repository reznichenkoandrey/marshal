import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AssistantCommandQueue } from "../desktop/assistant/command-queue.ts";
import { DISPATCHER_PROMPT } from "../desktop/assistant/dispatcher-files.ts";
import type { ClaudeSession } from "../desktop/claude-code/registry.ts";
import { parsePlan, type Plan } from "../desktop/plan-runner/plan.ts";
import { countSteps, renderReport, REPORT_FILE } from "../desktop/plan-runner/report.ts";
import { newPlanId, PlanRunner, projectOfSession, RUN_LOG_FILE, type RunnerEvent } from "../desktop/plan-runner/runner.ts";
import { loadPlan, savePlan } from "../desktop/plan-runner/store.ts";
import { PICKUP_WAIT_MS, pausePlan, readMarker, startRun, tick } from "../desktop/plan-runner/tick.ts";
import { readUsagePct, usageFromStatus } from "../desktop/plan-runner/usage.ts";
import { planCommand, planEventSentence, planStatusSentence } from "../desktop/plan-runner/voice.ts";

const PROJECT = "/Users/me/htdocs/marshal";
const ROOTS = ["/Users/me/htdocs"];
const START = Date.parse("2026-11-22T22:00:00Z");

const live = (name: string, overrides: Partial<ClaudeSession> = {}): ClaudeSession => ({
  pid: 100 + name.length,
  sessionId: `id-${name}`,
  name,
  cwd: PROJECT,
  status: "idle",
  waitingFor: null,
  entrypoint: "cli",
  socketPath: `/tmp/cc-socks/${name}.sock`,
  startedAt: 0,
  statusUpdatedAt: null,
  ...overrides
});

const RAW = {
  title: "Нічний план",
  lanes: [
    { id: "a", session: "alpha" },
    { id: "b", session: "beta" }
  ],
  steps: [
    { id: "s1", lane: "a", text: "Онови залежності", check: "npm run check проходить" },
    { id: "s2", lane: "a", text: "Прибери dead code", dependsOn: ["s1"] },
    { id: "s3", lane: "b", text: "Напиши тести для parser" }
  ]
};

type World = {
  root: string;
  now: number;
  enabled: boolean;
  roots: string[];
  sessions: ClaudeSession[];
  usage: number | null;
  listening: boolean;
  sent: { session: string; prompt: string }[];
  events: RunnerEvent[];
  runner: PlanRunner;
};

let world: World;

beforeEach(() => {
  const w = {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "marshal-plans-")),
    now: START,
    enabled: true,
    roots: ROOTS,
    sessions: [live("alpha"), live("beta", { cwd: `${PROJECT}/.claude/worktrees/beta` })],
    usage: 10 as number | null,
    listening: true,
    sent: [] as { session: string; prompt: string }[],
    events: [] as RunnerEvent[]
  };
  const runner = new PlanRunner({
    plansRoot: w.root,
    enabled: () => w.enabled,
    roots: () => w.roots,
    sessions: () => w.sessions,
    isAssistantSession: (session) => session.name === "general",
    usagePct: () => w.usage,
    canDeliver: () => w.listening,
    deliver: (session, prompt) => {
      if (w.listening) w.sent.push({ session, prompt });
      return w.listening;
    },
    notify: (event) => w.events.push(event),
    now: () => w.now,
    tickMs: 0
  });
  world = Object.assign(w, { runner });
});

afterEach(() => {
  world.runner.dispose();
  fs.rmSync(world.root, { recursive: true, force: true });
});

function created(raw: unknown = RAW): Plan {
  const result = world.runner.create(raw);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.plan;
}

const setStatus = (name: string, status: ClaudeSession["status"], waitingFor: string | null = null): void => {
  world.sessions = world.sessions.map((session) => (session.name === name ? { ...session, status, waitingFor } : session));
};
const states = (): string => (world.runner.current()?.steps ?? []).map((step) => `${step.id}:${step.state}`).join(" ");
const log = (id: string): string[] =>
  fs.readFileSync(path.join(world.root, id, RUN_LOG_FILE), "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
const refusal = (id: string): string => {
  const result = world.runner.run(id);
  return result.ok ? "started" : result.refusal;
};

describe("usage from the statusline", () => {
  it("reads the five-hour percentage and treats a reset window as empty", () => {
    const status = { rate_limits: { five_hour: { used_percentage: 42.5, resets_at: (START + 60_000) / 1000 } } };
    expect(usageFromStatus(status, START)).toBe(42.5);
    expect(usageFromStatus(status, START + 120_000)).toBe(0);
    expect(usageFromStatus({ rate_limits: {} }, START)).toBeNull();
    expect(usageFromStatus({ rate_limits: { five_hour: { used_percentage: "42" } } }, START)).toBeNull();
    expect(usageFromStatus(null, START)).toBeNull();
  });

  it("takes the newest session file that carries usage; no folder means unknown", () => {
    const dir = path.join(world.root, "usage");
    expect(readUsagePct(dir, START)).toBeNull();
    fs.mkdirSync(dir);
    const write = (name: string, body: string, mtime: number): void => {
      fs.writeFileSync(path.join(dir, name), body);
      fs.utimesSync(path.join(dir, name), mtime, mtime);
    };
    write("old.json", JSON.stringify({ rate_limits: { five_hour: { used_percentage: 20 } } }), 1000);
    write("new.json", JSON.stringify({ rate_limits: { five_hour: { used_percentage: 61 } } }), 2000);
    write("newest-without.json", JSON.stringify({ model: "x" }), 3000);
    write("broken.json", "{", 4000);
    write("previous-statusline.json", JSON.stringify({ rate_limits: { five_hour: { used_percentage: 99 } } }), 5000);
    expect(readUsagePct(dir, START)).toBe(61);
  });
});

describe("tick additions for the executor", () => {
  const stored = (): Plan => {
    const parsed = parsePlan({ ...RAW, id: "p1", project: PROJECT, lanes: RAW.lanes.map((lane) => ({ ...lane, source: "existing" })) }, { roots: ROOTS });
    if (!parsed.ok) throw new Error("fixture");
    return parsed.plan;
  };
  const sessions = [live("alpha"), live("beta")];

  it("names the step in the marker", () => {
    expect(readMarker("ok\nPLAN-STEP s1: done")).toEqual({ outcome: "done", stepId: "s1" });
    expect(readMarker("ok\nPLAN-STEP: failed")).toEqual({ outcome: "failed", stepId: null });
    expect(readMarker("PLAN-STEP s1: done\nmore")).toBeNull();
  });

  it("records the result of a step in flight on a paused plan and sends nothing", () => {
    const running = tick(startRun(stored(), START), { now: START, sessions, usagePct: 10 }).plan;
    const paused = pausePlan(running, "owner");
    expect(tick(paused, { now: START, sessions, usagePct: 10 }).changed).toBe(false);
    const out = tick(paused, { now: START, sessions, usagePct: 10, results: [{ stepId: "s1", outcome: "done" }] });
    expect(out.plan.steps[0].state).toBe("done");
    expect(out.plan.status).toBe("paused");
    expect(out.actions).toEqual([]);
  });

  it("lets a step in question finish once the session reports again", () => {
    let p = tick(startRun(stored(), START), { now: START, sessions, usagePct: 10 }).plan;
    p = tick(p, { now: START, sessions, usagePct: 10, results: [{ stepId: "s1", outcome: "question", question: "Яку версію?" }] }).plan;
    expect(p.steps[0]).toMatchObject({ state: "question", question: "Яку версію?" });
    p = tick(p, { now: START, sessions, usagePct: 10, results: [{ stepId: "s1", outcome: "done" }] }).plan;
    expect(p.steps[0]).toMatchObject({ state: "done", question: null });
    expect(p.steps[1].state).toBe("running");
  });
});

describe("creating a plan", () => {
  it("fills the id, the lane source and the project from the first lane's session", () => {
    const plan = created();
    expect(plan.id).toBe("plan-20261122-220000");
    expect(plan.project).toBe(PROJECT);
    expect(plan.lanes.map((lane) => lane.source)).toEqual(["existing", "existing"]);
    expect(plan.status).toBe("draft");
    expect(fs.existsSync(path.join(world.root, plan.id, REPORT_FILE))).toBe(true);
    expect(created().id).toBe("plan-20261122-220000-2");
  });

  it("derives the repository from a worktree session and builds unique ids", () => {
    expect(projectOfSession("/r/app/.claude/worktrees/x")).toBe("/r/app");
    expect(projectOfSession("/r/app")).toBe("/r/app");
    expect(newPlanId(START, ["plan-20261122-220000", "plan-20261122-220000-2"])).toBe("plan-20261122-220000-3");
  });

  it("refuses a forbidden step, a project outside the allowed folders and an unknown session", () => {
    const forbidden = world.runner.create({ ...RAW, steps: [{ id: "s1", lane: "a", text: "Зроби push у main" }] });
    expect(forbidden).toMatchObject({ ok: false, issues: [{ code: "forbidden", word: "push" }] });
    world.roots = [];
    expect(world.runner.create(RAW)).toMatchObject({ ok: false, issues: [{ code: "project-not-allowed" }] });
    world.roots = ROOTS;
    world.sessions = [];
    expect(world.runner.create(RAW)).toMatchObject({ ok: false, issues: [{ code: "project" }] });
    expect(fs.readdirSync(world.root)).toEqual([]);
  });
});

describe("starting a plan", () => {
  it("is off by default and refuses each broken precondition", () => {
    const id = created().id;
    world.enabled = false;
    expect(refusal(id)).toBe("disabled");
    world.enabled = true;
    world.listening = false;
    expect(refusal(id)).toBe("no-dispatcher");
    world.listening = true;
    world.usage = null;
    expect(refusal(id)).toBe("usage-unknown");
    world.usage = 97;
    expect(refusal(id)).toBe("usage-limit");
    world.usage = 10;
    expect(refusal("nope")).toBe("missing");
    expect(world.sent).toEqual([]);
    expect(log(id).filter((event) => event === "refused")).toHaveLength(4);
  });

  it("refuses sessions that are missing, elsewhere, duplicated, in the Claude app or the assistant's own", () => {
    const id = created().id;
    const [alpha, beta] = world.sessions;
    world.sessions = [alpha];
    expect(refusal(id)).toBe("session-missing");
    world.sessions = [alpha, { ...beta, cwd: "/Users/me/htdocs/other" }];
    expect(refusal(id)).toBe("session-outside");
    world.sessions = [alpha, beta, { ...beta, pid: 7, sessionId: "twin" }];
    expect(refusal(id)).toBe("session-ambiguous");
    world.sessions = [alpha, { ...beta, entrypoint: "claude-desktop" }];
    expect(refusal(id)).toBe("desktop-session");
    world.sessions = [alpha, beta];
    world.roots = ["/Users/me/elsewhere"];
    expect(refusal(id)).toBe("broken");

    world.roots = ROOTS;
    world.sessions = [alpha, live("general")];
    const own = created({ ...RAW, lanes: [{ id: "a", session: "alpha" }, { id: "b", session: "general" }] }).id;
    expect(refusal(own)).toBe("session-outside");
    expect(world.sent).toEqual([]);
  });

  it("never runs a plan that needs a new session", () => {
    const id = created({ ...RAW, lanes: [{ id: "a", session: "alpha" }, { id: "b", session: "fresh", source: "new" }] }).id;
    expect(refusal(id)).toBe("new-lane");
    expect(world.sent).toEqual([]);
  });

  it("runs one plan at a time", () => {
    const first = created().id;
    const second = created().id;
    expect(refusal(first)).toBe("started");
    expect(refusal(second)).toBe("busy");
  });
});

describe("running a plan on two open sessions", () => {
  const stop = (name: string, message: string): void => {
    setStatus(name, "idle");
    world.runner.onSessionStop(`id-${name}`, message);
  };

  it("sends three steps in order, records the answers and writes the report", () => {
    const id = created().id;
    expect(refusal(id)).toBe("started");
    expect(world.sent.map((item) => item.session)).toEqual(["alpha", "beta"]);
    expect(world.sent[0].prompt).toContain("Онови залежності");
    expect(world.sent[0].prompt).toContain("Do not push, pull, merge");
    expect(states()).toBe("s1:running s2:pending s3:running");

    setStatus("alpha", "busy");
    setStatus("beta", "busy");
    world.now += 60_000;
    world.runner.tick();
    expect(world.sent).toHaveLength(2);

    stop("alpha", "Оновив.\nPLAN-STEP s1: done");
    expect(states()).toBe("s1:done s2:running s3:running");
    expect(world.sent.at(-1)).toMatchObject({ session: "alpha" });
    expect(world.sent.at(-1)?.prompt).toContain("Прибери dead code");

    stop("beta", "Тести є.\nPLAN-STEP s3: done");
    setStatus("alpha", "busy");
    stop("alpha", "Готово.\nPLAN-STEP s2: done");
    expect(world.runner.current()?.status).toBe("done");
    expect(world.events.map((event) => event.kind)).toEqual(["finished"]);

    const onDisk = loadPlan(world.root, id, { roots: ROOTS });
    expect(onDisk.ok && onDisk.plan.status).toBe("done");
    const report = fs.readFileSync(path.join(world.root, id, REPORT_FILE), "utf8");
    expect(report).toContain("Status: **done**");
    expect(report).toContain("3 of 3 done");
    expect(report).toContain("did not push, merge, deploy or delete");
    expect(log(id)).toEqual(["created", "started", "sent", "sent", "answer", "sent", "answer", "answer", "finished"]);
    // The log names steps and outcomes, never the prompt or the answer.
    expect(fs.readFileSync(path.join(world.root, id, RUN_LOG_FILE), "utf8")).not.toContain("Онови");
  });

  it("treats an answer without the marker as a question and waits for the owner", () => {
    created();
    world.runner.run(world.runner.latestId() as string);
    stop("alpha", "Яку версію ставити, 5 чи 6?");
    expect(states()).toBe("s1:question s2:pending s3:running");
    expect(world.events.at(-1)).toMatchObject({ kind: "question", stepId: "s1", detail: "Яку версію ставити, 5 чи 6?" });
    const sentBefore = world.sent.length;
    stop("alpha", "Ще думаю.");
    expect(world.events.filter((event) => event.kind === "question")).toHaveLength(1);
    stop("alpha", "Поставив 6.\nPLAN-STEP s1: done");
    expect(states()).toBe("s1:done s2:running s3:running");
    expect(world.sent).toHaveLength(sentBefore + 1);
  });

  it("ignores an answer that names another step, and a stop of a session outside the plan", () => {
    created();
    world.runner.run(world.runner.latestId() as string);
    stop("alpha", "Пізня відповідь.\nPLAN-STEP s9: done");
    world.sessions = [...world.sessions, live("stranger", { cwd: "/Users/me/htdocs/other" })];
    world.runner.onSessionStop("id-stranger", "PLAN-STEP s1: done");
    expect(states()).toBe("s1:running s2:pending s3:running");
  });

  it("sends a failed step again as a fix round and holds what depends on a step that keeps failing", () => {
    created({ ...RAW, limits: { maxFixRounds: 1 } });
    world.runner.run(world.runner.latestId() as string);
    stop("alpha", "Тести червоні.\nPLAN-STEP s1: failed");
    expect(world.sent.at(-1)?.prompt).toContain("fix round 1 of 1");
    stop("alpha", "Досі червоні.\nPLAN-STEP s1: failed");
    expect(states()).toBe("s1:failed s2:held s3:running");
    expect(world.events.at(-1)).toMatchObject({ kind: "failed", stepId: "s1" });
  });

  it("repeats a prompt nobody picked up once, then fails the step", () => {
    created();
    world.runner.run(world.runner.latestId() as string);
    setStatus("beta", "busy");
    world.now += PICKUP_WAIT_MS;
    world.runner.tick();
    expect(world.sent.filter((item) => item.session === "alpha")).toHaveLength(2);
    world.now += PICKUP_WAIT_MS;
    world.runner.tick();
    expect(states()).toBe("s1:failed s2:held s3:running");
  });

  it("marks a step blocked while its session waits at a dialog and answers nothing", () => {
    created();
    world.runner.run(world.runner.latestId() as string);
    setStatus("alpha", "waiting", "permission prompt");
    world.runner.tick();
    expect(states()).toBe("s1:blocked s2:pending s3:running");
    expect(world.events.at(-1)).toMatchObject({ kind: "blocked", stepId: "s1", detail: "permission prompt" });
    expect(world.sent).toHaveLength(2);
  });

  it("stops sending at the usage limit and at the wall-clock limit", () => {
    created();
    world.runner.run(world.runner.latestId() as string);
    world.usage = 97;
    stop("alpha", "PLAN-STEP s1: done");
    expect(states()).toBe("s1:done s2:pending s3:running");
    world.usage = null;
    world.runner.tick();
    expect(states()).toBe("s1:done s2:pending s3:running");

    world.usage = 10;
    world.now += 480 * 60_000;
    world.runner.tick();
    expect(world.runner.current()).toMatchObject({ status: "paused", pauseReason: "wall-clock" });
    expect(states()).toBe("s1:done s2:pending s3:running");
    expect(world.events.at(-1)).toMatchObject({ kind: "paused", reason: "wall-clock" });
  });

  it("pauses when the opt-in is turned off, the project leaves the allowed folders or the dispatcher stops listening", () => {
    const first = created().id;
    world.runner.run(first);
    world.enabled = false;
    world.runner.tick();
    expect(world.runner.current()).toMatchObject({ status: "paused", pauseReason: "disabled" });

    world.enabled = true;
    world.runner.run(first);
    world.roots = ["/Users/me/elsewhere"];
    world.runner.tick();
    expect(world.runner.current()).toMatchObject({ status: "paused", pauseReason: "project-not-allowed" });

    world.roots = ROOTS;
    world.runner.run(first);
    world.listening = false;
    stop("alpha", "PLAN-STEP s1: done");
    expect(world.runner.current()).toMatchObject({ status: "paused", pauseReason: "no-dispatcher" });
    expect(world.events.map((event) => event.kind)).toEqual(["paused", "paused", "paused"]);
  });

  it("keeps recording answers after the owner pauses, and continues on resume", () => {
    const id = created().id;
    world.runner.run(id);
    const sentBefore = world.sent.length;
    expect(world.runner.pause()?.status).toBe("paused");
    expect(world.runner.pause()).toBeNull();
    stop("alpha", "PLAN-STEP s1: done");
    expect(states()).toBe("s1:done s2:pending s3:running");
    expect(world.sent).toHaveLength(sentBefore);
    expect(refusal(id)).toBe("started");
    expect(states()).toBe("s1:done s2:running s3:running");
  });
});

describe("after a restart", () => {
  it("pauses the plan that was running and sends its interrupted step again only on resume", () => {
    const id = created().id;
    world.runner.run(id);
    setStatus("alpha", "busy");
    world.runner.tick();
    world.runner.dispose();

    const sent: string[] = [];
    const second = new PlanRunner({
      plansRoot: world.root,
      enabled: () => true,
      roots: () => ROOTS,
      sessions: () => [live("alpha"), live("beta", { status: "busy" })],
      isAssistantSession: () => false,
      usagePct: () => 10,
      canDeliver: () => true,
      deliver: (session) => {
        sent.push(session);
        return true;
      },
      notify: () => {},
      now: () => START + 3_600_000,
      tickMs: 0
    });
    expect(second.restore()).toMatchObject({ id, status: "paused", pauseReason: "restart" });
    second.tick();
    expect(sent).toEqual([]);
    expect(second.run(id).ok).toBe(true);
    // alpha is idle with no answer recorded: its step goes out again; beta is still working.
    expect(sent).toEqual(["alpha"]);
    expect(second.current()?.steps.map((step) => step.state)).toEqual(["running", "pending", "running"]);
    second.dispose();
  });

  it("restores nothing when no plan was running", () => {
    created();
    expect(world.runner.restore()).toBeNull();
  });
});

describe("report", () => {
  it("counts the steps and lists what needs the owner first", () => {
    const base = created();
    const plan: Plan = {
      ...base,
      status: "paused",
      pauseReason: "wall-clock",
      steps: [
        { ...base.steps[0], state: "done", startedAt: START, finishedAt: START + 60_000 },
        { ...base.steps[1], state: "question", question: "Яку\nверсію?" },
        { ...base.steps[2], state: "failed", reason: "not-picked-up", resent: true }
      ]
    };
    expect(countSteps(plan)).toEqual({ total: 3, done: 1, running: 0, waiting: 1, failed: 1, pending: 0 });
    const report = renderReport(plan, START);
    expect(report).toContain("Status: **paused** (wall-clock)");
    expect(report.indexOf("## Needs you")).toBeLessThan(report.indexOf("## Steps"));
    expect(report).toContain("question: Яку версію?");
    expect(report).toContain("reason: not-picked-up; prompt repeated");
  });
});

describe("voice", () => {
  it("creates, runs, reports and pauses a plan by `./marshal do plan …`", () => {
    const opened: string[] = [];
    const say = (words: string, lang: "uk" | "en" = "uk"): string => planCommand(world.runner, words, lang, (file) => opened.push(file));
    expect(say("status")).toBe("Плану ще немає.");
    expect(say("run")).toBe("Плану ще немає.");
    expect(say(`create ${JSON.stringify(RAW)}`)).toBe("План «Нічний план» збережено, кроків: 3. Скажи «запусти план», щоб почати.");
    expect(say("pause")).toBe("Жоден план зараз не йде.");
    world.enabled = false;
    expect(say("run")).toBe("Plan runner вимкнено. Увімкни його в Settings, розділ голосового асистента.");
    expect(world.sent).toEqual([]);
    world.enabled = true;
    expect(say("run", "en")).toBe("Plan «Нічний план» is running, 3 steps.");
    expect(say("status")).toBe("План «Нічний план»: готово 0 з 3, іде 2, чекає на тебе 0, провалено 0. Він іде.");
    expect(say("report", "en")).toBe("Plan «Нічний план»: 0 of 3 steps done, 2 running, 0 waiting for you, 0 failed. It is running.");
    expect(opened).toEqual([path.join(world.root, "plan-20261122-220000", REPORT_FILE)]);
    expect(say("pause")).toBe("План на паузі. Кроки, що вже йдуть, дійдуть до кінця.");
    expect(say("run")).toBe("План «Нічний план» продовжено.");
    expect(say("dance")).toBe("Не знаю такої команди для плану.");
  });

  it("says why a plan was not saved or did not start", () => {
    const say = (words: string): string => planCommand(world.runner, words, "uk");
    expect(say("create {oops")).toBe("Не вдалося прочитати план.");
    expect(say(`create ${JSON.stringify({ ...RAW, steps: [{ id: "s1", lane: "a", text: "Задеплой на прод" }] })}`)).toBe(
      "Крок s1 просить deploy. Runner цього не робить, тому план не збережено."
    );
    world.roots = [];
    expect(say(`create ${JSON.stringify(RAW)}`)).toBe("Проєкт поза дозволеними теками. Додай його в Settings, розділ Claude Code.");
    world.roots = ROOTS;
    say(`create ${JSON.stringify(RAW)}`);
    world.sessions = [world.sessions[0]];
    expect(say("run")).toBe("Сесія beta не відкрита.");
    world.usage = 98;
    world.sessions = [live("alpha"), live("beta")];
    expect(say("run")).toBe("Usage на 98 відсотках. План не стартує.");
  });

  it("phrases the runner's own events", () => {
    const plan = startRun(created(), START);
    expect(planEventSentence({ kind: "question", plan, stepId: "s3", detail: null }, "uk")).toBe("План: на кроці s3 сесія beta має до тебе питання.");
    expect(planEventSentence({ kind: "paused", plan, reason: "wall-clock" }, "en")).toBe("Plan «Нічний план» is paused: its time limit is over.");
    expect(planEventSentence({ kind: "paused", plan, reason: "something-new" }, "en")).toBe("Plan «Нічний план» is paused.");
    expect(planEventSentence({ kind: "finished", plan, }, "uk")).toBe("План «Нічний план» завершено: готово 0 з 3, провалено 0.");
    expect(planStatusSentence(pausePlan(plan, "owner"), "uk")).toContain("Він на паузі.");
  });
});

describe("delivery through the dispatcher", () => {
  it("marks a plan step in the command stream and tells the dispatcher to pass it on verbatim", () => {
    const lines: string[] = [];
    const queue = new AssistantCommandQueue(() => START);
    queue.connect({ write: (line) => lines.push(line) });
    expect(queue.submit("step prompt", { plan: "alpha" })).toBe(true);
    expect(JSON.parse(lines[0])).toMatchObject({ text: "step prompt", plan: "alpha" });
    expect(JSON.parse(lines[0])).not.toHaveProperty("target");
    expect(DISPATCHER_PROMPT).toContain("## Events with `plan`");
    expect(DISPATCHER_PROMPT).toContain("./marshal do plan create <json>");
  });
});
