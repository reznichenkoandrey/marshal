import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findForbidden } from "../desktop/plan-runner/forbidden.ts";
import { parsePlan, type Plan, type PlanIssue } from "../desktop/plan-runner/plan.ts";
import { PLAN_BACKUP_FILE, PLAN_FILE, listPlanIds, loadPlan, savePlan } from "../desktop/plan-runner/store.ts";
import {
  MAX_SPAWNS,
  PICKUP_WAIT_MS,
  SPAWN_WAIT_MS,
  modelMayAnswer,
  parseMarker,
  pausePlan,
  startRun,
  stepPrompt,
  tick,
  type PlanAction,
  type SessionFact,
  type TickFacts
} from "../desktop/plan-runner/tick.ts";

const ROOTS = ["/Users/me/htdocs"];
const CONTEXT = { roots: ROOTS };
const NOW = Date.parse("2026-11-22T22:00:00Z");

type RawStep = Record<string, unknown>;

function rawPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "2026-11-22-deps",
    title: "Оновити залежності",
    project: "/Users/me/htdocs/marshal",
    lanes: [
      { id: "A", session: "runner-A", source: "existing" },
      { id: "B", session: "runner-B", source: "new" }
    ],
    steps: [
      { id: "s1", lane: "A", text: "Онови devDependencies", check: "npm run check проходить" },
      { id: "s2", lane: "A", text: "Прибери dead code", dependsOn: ["s1"] },
      { id: "s3", lane: "B", text: "Напиши тести для parser" }
    ] satisfies RawStep[],
    ...overrides
  };
}

function plan(overrides: Record<string, unknown> = {}): Plan {
  const parsed = parsePlan(rawPlan(overrides), CONTEXT);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.plan;
}

function issues(overrides: Record<string, unknown>, context = CONTEXT): PlanIssue[] {
  const parsed = parsePlan(rawPlan(overrides), context);
  return parsed.ok ? [] : parsed.issues;
}

const session = (name: string, status: SessionFact["status"] = "idle", extra: Partial<SessionFact> = {}): SessionFact => ({
  name,
  status,
  waitingFor: null,
  entrypoint: "cli",
  ...extra
});

const facts = (overrides: Partial<TickFacts> = {}): TickFacts => ({
  now: NOW,
  sessions: [session("runner-A"), session("runner-B")],
  usagePct: 10,
  ...overrides
});

const sends = (actions: PlanAction[]): string[] =>
  actions.flatMap((action) => (action.type === "send" ? [`${action.kind}:${action.stepId}`] : []));
const state = (p: Plan, id: string): string => p.steps.find((step) => step.id === id)?.state ?? "?";

describe("findForbidden", () => {
  it.each([
    ["Зроби git push у origin", "push"],
    ["потім запуш гілку", "push"],
    ["git pull перед стартом", "pull"],
    ["змердж у main", "merge"],
    ["Merge the branch", "merge"],
    ["зроби rebase на main", "rebase"],
    ["задеплой на прод", "deploy"],
    ["npm publish", "release"],
    ["git reset --hard HEAD~1", "reset --hard"],
    ["git clean -fd", "git clean"],
    ["rm -rf node_modules", "rm -r"],
    ["git branch -D old", "delete branch"],
    ["видали гілку feature/x", "delete branch"],
    ["delete the branch afterwards", "delete branch"]
  ])("%s → %s", (text, word) => {
    expect(findForbidden(text)).toBe(word);
  });

  it.each(["Онови devDependencies і запусти npm run check", "Add a pushdown automaton test", "Напиши тести для emergency parser"])(
    "allows %s",
    (text) => {
      expect(findForbidden(text)).toBeNull();
    }
  );
});

describe("parsePlan", () => {
  it("fills defaults and starts every step pending", () => {
    const p = plan({ steps: [{ id: "s1", lane: "A", text: "Крок", state: "done", fixRounds: 9 }] });
    expect(p.base).toBe("main");
    expect(p.status).toBe("draft");
    expect(p.limits).toEqual({ maxFixRounds: 2, maxWallMinutes: 480, stopAtUsagePct: 97 });
    expect(p.steps[0]).toMatchObject({ state: "pending", fixRounds: 0, dependsOn: [], check: null, notBefore: null });
  });

  it("rejects a step that asks for a forbidden operation and names the step and the word", () => {
    const found = issues({ steps: [{ id: "s1", lane: "A", text: "Онови і зроби git push" }] });
    expect(found).toEqual([expect.objectContaining({ code: "forbidden", stepId: "s1", word: "push" })]);
    expect(issues({ steps: [{ id: "s1", lane: "A", text: "Онови", check: "merged into main" }] })[0]).toMatchObject({
      code: "forbidden",
      word: "merge"
    });
  });

  it("accepts only a project under the allowed folders, and none when no folder is allowed", () => {
    expect(issues({ project: "/Users/me/work/shop" })[0].code).toBe("project-not-allowed");
    expect(issues({ project: "/Users/me/htdocs-other/x" })[0].code).toBe("project-not-allowed");
    expect(issues({}, { roots: [] })[0].code).toBe("project-not-allowed");
    expect(issues({ project: "relative/path" })[0].code).toBe("project");
  });

  it("rejects ids that could leave the plans folder or break a shell command", () => {
    expect(issues({ id: "../etc" })[0].code).toBe("id");
    expect(issues({ id: "Plan One" })[0].code).toBe("id");
    expect(issues({ lanes: [{ id: "A", session: "x; rm -rf ~", source: "new" }] })[0].code).toBe("lanes");
    expect(issues({ base: "--upload-pack=x" })[0].code).toBe("base");
    expect(issues({ base: "main..evil" })[0].code).toBe("base");
  });

  it("limits lanes to two and requires unique lanes and sessions", () => {
    const lane = (id: string, name = `runner-${id}`): Record<string, string> => ({ id, session: name, source: "existing" });
    expect(issues({ lanes: [lane("A"), lane("B"), lane("C")] })[0].code).toBe("lanes");
    expect(issues({ lanes: [lane("A"), lane("B", "runner-A")] })[0].code).toBe("lanes");
    expect(issues({ lanes: [] })[0].code).toBe("lanes");
  });

  it("rejects unknown dependencies and cycles", () => {
    expect(issues({ steps: [{ id: "s1", lane: "A", text: "a", dependsOn: ["nope"] }] })[0].code).toBe("dependency");
    expect(
      issues({
        steps: [
          { id: "s1", lane: "A", text: "a", dependsOn: ["s2"] },
          { id: "s2", lane: "A", text: "b", dependsOn: ["s1"] }
        ]
      })[0].code
    ).toBe("cycle");
  });

  it("never lets a plan raise the usage ceiling above 97%", () => {
    expect(issues({ limits: { stopAtUsagePct: 100 } })[0].code).toBe("limits");
    expect(issues({ limits: { maxFixRounds: 99 } })[0].code).toBe("limits");
    expect(plan({ limits: { stopAtUsagePct: 80 } }).limits.stopAtUsagePct).toBe(80);
  });

  it("rejects a bad notBefore and anything that is not an object", () => {
    expect(issues({ steps: [{ id: "s1", lane: "A", text: "a", notBefore: "tonight" }] })[0].code).toBe("steps");
    expect(parsePlan("plan", CONTEXT)).toMatchObject({ ok: false, issues: [{ code: "shape" }] });
  });
});

describe("tick", () => {
  const running = (overrides: Record<string, unknown> = {}): Plan => startRun(plan(overrides), NOW);

  it("does nothing for a plan that is not running", () => {
    const draft = plan();
    expect(tick(draft, facts())).toEqual({ plan: draft, actions: [], changed: false });
    expect(tick(pausePlan(running(), "owner"), facts()).actions).toEqual([]);
  });

  it("starts the first step of each lane in parallel and keeps a lane strictly in order", () => {
    const first = tick(running(), facts());
    expect(sends(first.actions)).toEqual(["step:s1", "step:s3"]);
    expect(state(first.plan, "s2")).toBe("pending");
    const send = first.actions.find((action) => action.type === "send");
    expect(send).toMatchObject({ session: "runner-A", lane: "A" });

    const second = tick(first.plan, facts({ now: NOW + 1000, sessions: [session("runner-A", "busy"), session("runner-B", "busy")] }));
    expect(second.actions).toEqual([]);

    const third = tick(second.plan, facts({ now: NOW + 5000, results: [{ stepId: "s1", outcome: "done" }] }));
    expect(state(third.plan, "s1")).toBe("done");
    expect(sends(third.actions)).toEqual(["step:s2"]);
  });

  it("waits for an idle session", () => {
    const result = tick(running(), facts({ sessions: [session("runner-A", "busy"), session("runner-B", "waiting")] }));
    expect(result.actions).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("starts nothing at the usage limit or when usage is unknown", () => {
    expect(tick(running(), facts({ usagePct: 97 })).actions).toEqual([]);
    expect(tick(running(), facts({ usagePct: null })).actions).toEqual([]);
    expect(sends(tick(running(), facts({ usagePct: 96 })).actions)).toHaveLength(2);
  });

  it("holds a step until notBefore and records a late start", () => {
    const at = new Date(NOW + 3_600_000).toISOString();
    const p = running({ steps: [{ id: "s1", lane: "A", text: "a", notBefore: at }] });
    expect(tick(p, facts()).actions).toEqual([]);
    const late = tick(p, facts({ now: NOW + 3_600_000 + 600_000 }));
    expect(sends(late.actions)).toEqual(["step:s1"]);
    expect(late.plan.steps[0].lateMs).toBe(600_000);
  });

  it("gives a failed step fix rounds, then fails it and holds everything that depends on it", () => {
    let p = tick(running(), facts()).plan;
    for (const round of [1, 2]) {
      const failed = tick(p, facts({ now: NOW + round * 1000, results: [{ stepId: "s1", outcome: "failed" }] }));
      expect(sends(failed.actions)).toEqual(["fix:s1"]);
      expect(failed.plan.steps[0].fixRounds).toBe(round);
      const send = failed.actions.find((action) => action.type === "send");
      expect(send?.type === "send" && send.prompt).toContain(`fix round ${round} of 2`);
      p = failed.plan;
    }
    const exhausted = tick(p, facts({ now: NOW + 9000, results: [{ stepId: "s1", outcome: "failed" }] }));
    expect(exhausted.plan.steps[0]).toMatchObject({ state: "failed", reason: "fix-rounds-exhausted" });
    expect(exhausted.plan.steps[1]).toMatchObject({ state: "held", reason: "depends-on:s1" });
    // The other lane does not depend on s1 and keeps going.
    expect(state(exhausted.plan, "s3")).toBe("running");
    expect(exhausted.actions).toContainEqual({ type: "notify", kind: "failed", stepId: "s1", detail: "fix-rounds-exhausted" });
  });

  it("propagates a hold down the whole dependency graph and finishes the plan", () => {
    const p = running({
      lanes: [{ id: "A", session: "runner-A", source: "existing" }],
      steps: [
        { id: "s1", lane: "A", text: "a" },
        { id: "s2", lane: "A", text: "b", dependsOn: ["s1"] },
        { id: "s3", lane: "A", text: "c", dependsOn: ["s2"] }
      ],
      limits: { maxFixRounds: 0 }
    });
    const started = tick(p, facts()).plan;
    const done = tick(started, facts({ results: [{ stepId: "s1", outcome: "failed" }] }));
    expect(done.plan.steps.map((step) => step.state)).toEqual(["failed", "held", "held"]);
    expect(done.plan.status).toBe("done");
    expect(done.actions).toContainEqual({ type: "finish" });
  });

  it("fails a step on a provider error without a fix round", () => {
    const started = tick(running(), facts()).plan;
    const result = tick(started, facts({ results: [{ stepId: "s1", outcome: "failed", provider: true }] }));
    expect(result.plan.steps[0]).toMatchObject({ state: "failed", reason: "provider", fixRounds: 0 });
  });

  it("marks a step blocked on a permission prompt, answers nothing, and resumes when the owner did", () => {
    const started = tick(running(), facts()).plan;
    const waiting = [session("runner-A", "waiting", { waitingFor: "permission prompt" }), session("runner-B", "busy")];
    const blocked = tick(started, facts({ sessions: waiting }));
    expect(blocked.plan.steps[0]).toMatchObject({ state: "blocked", reason: "permission prompt" });
    expect(blocked.actions).toEqual([{ type: "notify", kind: "blocked", stepId: "s1", detail: "permission prompt" }]);
    // Still waiting: no second notice, nothing sent.
    expect(tick(blocked.plan, facts({ sessions: waiting })).actions).toEqual([]);
    const resumed = tick(blocked.plan, facts({ sessions: [session("runner-A", "busy"), session("runner-B", "busy")] }));
    expect(resumed.plan.steps[0]).toMatchObject({ state: "running", reason: null });
  });

  it("keeps a lane closed while its question is open", () => {
    const started = tick(running(), facts()).plan;
    const asked = tick(started, facts({ results: [{ stepId: "s1", outcome: "question", question: "Яку версію брати?" }] }));
    expect(asked.plan.steps[0]).toMatchObject({ state: "question", question: "Яку версію брати?" });
    expect(asked.actions).toContainEqual({ type: "notify", kind: "question", stepId: "s1", detail: "Яку версію брати?" });
    const later = facts({ now: NOW + 60_000, sessions: [session("runner-A"), session("runner-B", "busy")] });
    expect(sends(tick(asked.plan, later).actions)).toEqual([]);
    expect(asked.plan.status).toBe("running");
  });

  it("repeats a prompt once when the session did not pick it up, then fails the step", () => {
    const started = tick(running({ lanes: [{ id: "A", session: "runner-A", source: "existing" }], steps: [{ id: "s1", lane: "A", text: "a" }] }), facts()).plan;
    expect(tick(started, facts({ now: NOW + PICKUP_WAIT_MS - 1 })).actions).toEqual([]);
    const resent = tick(started, facts({ now: NOW + PICKUP_WAIT_MS }));
    expect(sends(resent.actions)).toEqual(["resend:s1"]);
    const failed = tick(resent.plan, facts({ now: NOW + 2 * PICKUP_WAIT_MS }));
    expect(failed.plan.steps[0]).toMatchObject({ state: "failed", reason: "not-picked-up" });
  });

  it("does not repeat a prompt the session was seen working on", () => {
    const started = tick(running(), facts()).plan;
    const seen = tick(started, facts({ now: NOW + 1000, sessions: [session("runner-A", "busy"), session("runner-B", "busy")] })).plan;
    expect(tick(seen, facts({ now: NOW + 10 * PICKUP_WAIT_MS })).actions).toEqual([]);
  });

  it("fails an existing lane whose session is gone or ambiguous", () => {
    const gone = tick(running(), facts({ sessions: [session("runner-B")] }));
    expect(gone.plan.steps[0]).toMatchObject({ state: "failed", reason: "session-gone" });
    expect(state(gone.plan, "s2")).toBe("held");
    const twice = tick(running(), facts({ sessions: [session("runner-A"), session("runner-A"), session("runner-B")] }));
    expect(twice.plan.steps[0]).toMatchObject({ state: "failed", reason: "session-ambiguous" });
  });

  it("asks for a new lane's session, waits for it, and gives up after a bounded number of starts", () => {
    const only = { lanes: [{ id: "B", session: "runner-B", source: "new" }], steps: [{ id: "s3", lane: "B", text: "c" }] };
    let result = tick(running(only), facts({ sessions: [] }));
    expect(result.actions).toEqual([{ type: "spawn", lane: "B", session: "runner-B" }]);
    expect(tick(result.plan, facts({ sessions: [], now: NOW + SPAWN_WAIT_MS - 1 })).actions).toEqual([]);
    let now = NOW;
    for (let attempt = 2; attempt <= MAX_SPAWNS; attempt += 1) {
      now += SPAWN_WAIT_MS;
      result = tick(result.plan, facts({ sessions: [], now }));
      expect(result.actions).toEqual([{ type: "spawn", lane: "B", session: "runner-B" }]);
    }
    result = tick(result.plan, facts({ sessions: [], now: now + SPAWN_WAIT_MS }));
    expect(result.plan.steps[0]).toMatchObject({ state: "failed", reason: "spawn-failed" });
  });

  it("sends the step again to a restarted session of a new lane", () => {
    const started = tick(running(), facts()).plan;
    const gone = tick(started, facts({ now: NOW + 1000, sessions: [session("runner-A", "busy")] }));
    expect(state(gone.plan, "s3")).toBe("pending");
    expect(gone.actions).toContainEqual({ type: "spawn", lane: "B", session: "runner-B" });
    const back = tick(gone.plan, facts({ now: NOW + 5000, sessions: [session("runner-A", "busy"), session("runner-B")] }));
    expect(sends(back.actions)).toEqual(["step:s3"]);
  });

  it("refuses a Claude desktop session", () => {
    const result = tick(running(), facts({ sessions: [session("runner-A", "idle", { entrypoint: "claude-desktop" }), session("runner-B")] }));
    expect(result.plan.steps[0]).toMatchObject({ state: "failed", reason: "desktop-session" });
    expect(sends(result.actions)).toEqual(["step:s3"]);
  });

  it("pauses at the wall-clock limit and starts nothing after it", () => {
    const p = running({ limits: { maxWallMinutes: 60 } });
    const result = tick(p, facts({ now: NOW + 60 * 60_000 }));
    expect(result.plan).toMatchObject({ status: "paused", pauseReason: "wall-clock" });
    expect(result.actions).toEqual([{ type: "pause", reason: "wall-clock" }]);
    expect(tick(result.plan, facts({ now: NOW + 61 * 60_000 })).actions).toEqual([]);
    // A resume by the owner opens a new window; the first start time stays.
    const resumed = startRun(result.plan, NOW + 90 * 60_000);
    expect(resumed.runStartedAt).toBe(NOW);
    expect(sends(tick(resumed, facts({ now: NOW + 91 * 60_000 })).actions)).toHaveLength(2);
  });

  it("still records results that arrive at the wall-clock limit", () => {
    const started = tick(running({ limits: { maxWallMinutes: 60 } }), facts()).plan;
    const result = tick(started, facts({ now: NOW + 60 * 60_000, results: [{ stepId: "s1", outcome: "done" }] }));
    expect(state(result.plan, "s1")).toBe("done");
    expect(sends(result.actions)).toEqual([]);
  });

  it("does not mutate the plan it was given", () => {
    const p = running();
    const copy = structuredClone(p);
    tick(p, facts());
    expect(p).toEqual(copy);
  });
});

describe("step prompt and marker", () => {
  it("carries the step, the check, the forbidden list and the marker contract", () => {
    const p = plan();
    const prompt = stepPrompt(p, p.steps[0]);
    expect(prompt).toContain("Онови devDependencies");
    expect(prompt).toContain("Done when: npm run check проходить");
    expect(prompt).toContain("Do not push, pull, merge, rebase, deploy");
    expect(prompt.trimEnd().endsWith("PLAN-STEP: question")).toBe(true);
  });

  it("reads the marker only from the last line", () => {
    expect(parseMarker("All good.\nPLAN-STEP: done\n")).toBe("done");
    expect(parseMarker("Broke.\n**PLAN-STEP: failed**")).toBe("failed");
    expect(parseMarker("Which one?\n`PLAN-STEP: QUESTION`")).toBe("question");
    expect(parseMarker("PLAN-STEP: done\nand then some more text")).toBeNull();
    expect(parseMarker("PLAN-STEP: approved")).toBeNull();
    expect(parseMarker("")).toBeNull();
  });
});

describe("modelMayAnswer", () => {
  const p = plan({ steps: [{ id: "s1", lane: "A", text: "Онови vitest до версії 3.2 і запусти npm run check" }] });

  it("allows only an answer that is literally in the plan", () => {
    expect(modelMayAnswer("Яку версію vitest брати?", "версії 3.2.", p)).toBe(true);
    expect(modelMayAnswer("Яку версію vitest брати?", "версії 4.0", p)).toBe(false);
    expect(modelMayAnswer("Продовжувати?", "ok", p)).toBe(false);
  });

  it("never answers a question about push, merge, deploy or delete", () => {
    expect(modelMayAnswer("Можна зробити git push?", "npm run check", p)).toBe(false);
    expect(modelMayAnswer("Should I merge it?", "vitest", p)).toBe(false);
    expect(modelMayAnswer("Що далі?", "запуш і запусти npm run check", p)).toBe(false);
  });
});

describe("plan store", () => {
  const dirs: string[] = [];
  const root = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plans-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a running plan with its run state", () => {
    const dir = root();
    const started = tick(startRun(plan(), NOW), facts()).plan;
    savePlan(dir, started);
    expect(loadPlan(dir, started.id, CONTEXT)).toEqual({ ok: true, plan: started, recovered: false });
    expect(listPlanIds(dir)).toEqual([started.id]);
    expect(fs.statSync(path.join(dir, started.id, PLAN_FILE)).mode & 0o777).toBe(0o600);
  });

  it("recovers the previous state from the backup when plan.json is broken", () => {
    const dir = root();
    const first = startRun(plan(), NOW);
    savePlan(dir, first);
    const second = tick(first, facts()).plan;
    savePlan(dir, second);
    const file = path.join(dir, first.id, PLAN_FILE);
    fs.writeFileSync(file, '{"id": "2026-11-22-deps", "steps": [');
    const loaded = loadPlan(dir, first.id, CONTEXT);
    expect(loaded).toEqual({ ok: true, plan: first, recovered: true });
    // The broken file stays for the owner; a save after recovery keeps the good backup.
    savePlan(dir, first);
    expect(JSON.parse(fs.readFileSync(path.join(dir, first.id, PLAN_BACKUP_FILE), "utf8"))).toEqual(first);
    expect(loadPlan(dir, first.id, CONTEXT)).toMatchObject({ ok: true, recovered: false });
  });

  it("does not load a plan with no valid copy, and says why", () => {
    const dir = root();
    fs.mkdirSync(path.join(dir, "broken"));
    fs.writeFileSync(path.join(dir, "broken", PLAN_FILE), "not json");
    expect(loadPlan(dir, "broken", CONTEXT)).toMatchObject({ ok: false, reason: "broken", issues: [{ code: "shape" }] });
    expect(loadPlan(dir, "absent", CONTEXT)).toMatchObject({ ok: false, reason: "missing" });
    expect(loadPlan(dir, "../broken", CONTEXT)).toMatchObject({ ok: false, reason: "invalid-id" });
  });

  it("runs the safety checks again on a stored plan", () => {
    const dir = root();
    const saved = plan({ lanes: [{ id: "A", session: "runner-A", source: "existing" }], steps: [{ id: "s1", lane: "A", text: "a" }] });
    savePlan(dir, saved);
    const file = path.join(dir, saved.id, PLAN_FILE);

    const edited = { ...saved, steps: [{ ...saved.steps[0], text: "git push origin main" }] };
    fs.writeFileSync(file, JSON.stringify(edited));
    expect(loadPlan(dir, saved.id, CONTEXT)).toMatchObject({ ok: false, issues: [{ code: "forbidden", word: "push" }] });

    fs.writeFileSync(file, JSON.stringify(saved));
    expect(loadPlan(dir, saved.id, { roots: ["/Users/me/other"] })).toMatchObject({
      ok: false,
      issues: [{ code: "project-not-allowed" }]
    });

    fs.writeFileSync(file, JSON.stringify({ ...saved, steps: [{ ...saved.steps[0], state: "approved" }] }));
    expect(loadPlan(dir, saved.id, CONTEXT)).toMatchObject({ ok: false, reason: "broken" });

    fs.writeFileSync(file, JSON.stringify({ ...saved, id: "another-plan" }));
    expect(loadPlan(dir, saved.id, CONTEXT)).toMatchObject({ ok: false, issues: [{ code: "id" }] });
  });

  it("refuses to save under an id that is not a plain folder name", () => {
    expect(() => savePlan(root(), { ...plan(), id: "../escape" })).toThrow("invalid plan id");
  });
});
