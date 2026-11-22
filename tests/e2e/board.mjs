// E2E check of the board window in a real Electron renderer (#276).
//
// Loads the shipped board.html with a stub `window.marshalBoard` in place of
// the model, and the real bundled Mermaid. What only a renderer can show:
// Mermaid loads under the window's CSP and only on the first draw, the quoting
// fixtures parse (and the broken ones do not), Cyrillic labels use the bundled
// font, a broken diagram is repaired once, and a second failure keeps the last
// good render with one error line.
//
// Run: `npm run test:e2e:board` (MARSHAL_E2E_SHOTS=<dir> saves a screenshot)
//
// Exit codes: 0 — every check passed, 1 — a check failed, 2 — the run threw.

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

import { quietApp, showQuietly } from "./quiet-window.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RENDERER = path.join(ROOT, "dist", "desktop", "renderer");

const checks = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, passed, detail) {
  checks[name] = { passed, detail };
  console.log(`[board-e2e] ${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const GOOD = 'flowchart TD\n  start["Початок деплою"] --> check{"Тести зелені?"}\n  check -->|"так"| ship["deploy на прод"]';
const BROKEN = "flowchart TD\n  a[login(user)] --> b[ok]";
const FIXED = 'flowchart TD\n  a["login(user)"] --> b["Виправлено"]';

/** A stub preload: scripted model replies, and a probe the test reads back. */
function preloadSource() {
  return `
const { contextBridge } = require("electron");
const calls = { draw: [], repair: [], save: [], brainstorm: [], reveal: 0 };
let onRequest = null;
let onDelta = null;
const FIRST = [
  '{"op":"addNode","id":"root","label":"Ціни на підписку","type":"idea"}',
  '{"op":"addNode","id":"churn","label":"Відтік після підвищення","type":"risk"}',
  '{"op":"addEdge","from":"root","to":"churn"}',
  '{"op":"addNode","id":"survey","label":"Опитати клієнтів","type":"task"}',
  '{"op":"addEdge","from":"root","to":"survey","label":"спершу"}',
  '{"op":"setSummary","text":"Думаємо про ціни."}',
  '{"op":"setTasks","items":["Опитати клієнтів"]}',
  '{"op":"setQuestions","items":["Скільки платять конкуренти?"]}'
];
const SECOND = [
  '{"op":"addNode","id":"tiers","label":"Три тарифи замість одного","type":"decision"}',
  '{"op":"addEdge","from":"root","to":"tiers"}',
  '{"op":"addNode","id":"ratelimit","label":"rate limit на дешевому тарифі?","type":"question"}',
  '{"op":"addEdge","from":"tiers","to":"ratelimit"}',
  '{"op":"setSummary","text":"Три тарифи, відкрите питання про rate limit."}',
  '{"op":"setTasks","items":["Опитати клієнтів","Порахувати тарифи"]}',
  '{"op":"setQuestions","items":[]}'
];
let repairMode = "good";
const fence = (source) => "Here it is:\\n\`\`\`mermaid\\n" + source + "\\n\`\`\`\\n";

contextBridge.exposeInMainWorld("marshalBoard", {
  draw: async (input) => {
    calls.draw.push(input);
    if (input.text.includes("offline")) return { ok: false, error: "The model did not answer." };
    return { ok: true, text: fence(input.text.includes("broken") ? ${JSON.stringify(BROKEN)} : ${JSON.stringify(GOOD)}) };
  },
  repair: async (input) => {
    calls.repair.push(input);
    return { ok: true, text: repairMode === "good" ? fence(${JSON.stringify(FIXED)}) : ${JSON.stringify(BROKEN)} };
  },
  onRequest: (cb) => { onRequest = cb; },
  onDelta: (cb) => { onDelta = cb; },
  // The reply streams: its first line arrives well before the rest, like a real model.
  brainstorm: async (input) => {
    calls.brainstorm.push(input);
    if (input.text.includes("offline")) return { ok: false, error: "The model did not answer." };
    if (input.text.includes("prose")) return { ok: true, text: "I think this is a good idea." };
    const lines = input.board.nodes.length === 0 ? FIRST : SECOND;
    onDelta?.({}, { delta: lines[0] + "\\n" + lines[1].slice(0, 20) });
    await new Promise((resolve) => setTimeout(resolve, 500));
    onDelta?.({}, { delta: lines[1].slice(20) + "\\n" + lines.slice(2).join("\\n") });
    return { ok: true, text: lines.join("\\n") };
  },
  save: async (input) => { calls.save.push(input); return { ok: true, id: "test" }; },
  reveal: async () => { calls.reveal++; return { ok: true }; },
  close: async () => ({ ok: true })
});
contextBridge.exposeInMainWorld("__boardProbe", {
  calls: () => calls,
  setRepair: (mode) => { repairMode = mode; },
  // What main sends for \`./marshal do board <words>\`.
  speak: (text, mode) => onRequest?.({}, { text, mode })
});
`;
}

const STATE = `({
  status: document.getElementById("status").textContent,
  error: document.getElementById("error").hidden ? "" : document.getElementById("error").textContent,
  svg: document.querySelector("#diagram svg") !== null,
  text: document.getElementById("diagram").textContent,
  source: document.getElementById("source").textContent,
  emptyShown: !document.getElementById("empty").hidden,
  busy: document.getElementById("draw-btn").disabled
})`;

app.on("window-all-closed", () => {});
quietApp(app);

const WATCHDOG_MS = 90_000;
const watchdog = setTimeout(() => {
  console.error(`[board-e2e] timed out after ${WATCHDOG_MS}ms`);
  app.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

async function main() {
  await app.whenReady();
  const quoting = JSON.parse(await fs.readFile(path.join(ROOT, "tests", "fixtures", "boards", "quoting.json"), "utf8"));

  const preloadPath = path.join(os.tmpdir(), `marshal-board-preload-${process.pid}.cjs`);
  await fs.writeFile(preloadPath, preloadSource(), "utf8");

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  });
  const consoleErrors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });
  // Module imports from file:// do not show up in the page's resource timing.
  let mermaidFiles = 0;
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.includes("/vendor/mermaid/")) mermaidFiles++;
    callback({});
  });
  await win.loadFile(path.join(RENDERER, "board.html"));
  showQuietly(win);
  await sleep(300);

  const run = (code) => win.webContents.executeJavaScript(code);
  const state = () => run(STATE);
  const mermaidRequests = async () => mermaidFiles;
  async function draw(text) {
    await run(`document.getElementById("request").value = ${JSON.stringify(text)}; document.getElementById("draw-btn").click()`);
    for (let i = 0; i < 150; i++) {
      await sleep(100);
      if (!(await state()).busy) break;
    }
    return state();
  }

  // Informational, not a gate: the budget itself is measured with `npm run perf:footprint`.
  const rendererMb = () => {
    const pid = win.webContents.getOSProcessId();
    const metric = app.getAppMetrics().find((item) => item.pid === pid);
    return Math.round((metric?.memory.workingSetSize ?? 0) / 1024);
  };
  const idleMb = rendererMb();

  // ── Nothing of Mermaid before the first diagram ─────────────────────────
  record("Mermaid is not loaded with the window", (await mermaidRequests()) === 0);
  record("an empty board shows the placeholder", (await state()).emptyShown);

  // ── Request → model → diagram ───────────────────────────────────────────
  let now = await draw("намалюй деплой");
  let calls = await run("window.__boardProbe.calls()");
  record("a request draws a diagram", now.svg && now.status === "Done" && now.error === "", `${now.status} ${now.error}`);
  record("Cyrillic labels are on the board", now.text.includes("Початок деплою") && now.text.includes("Тести зелені?"));
  record("the source is shown without the fence", now.source === GOOD);
  record("the request reached the model with its language setting", calls.draw[0]?.language === "auto" && calls.draw[0]?.text === "намалюй деплой");
  record("a diagram that parses costs no repair call", calls.repair.length === 0);
  record("Mermaid loaded on the first draw", (await mermaidRequests()) > 0, `${mermaidFiles} files`);
  console.log(`[board-e2e] renderer working set: ${idleMb} MB open and empty, ${rendererMb()} MB after the first diagram`);

  // ── Saved as board.mmd ──────────────────────────────────────────────────
  record(
    "a drawn diagram is saved with its request",
    calls.save.length === 1 && calls.save[0].source === GOOD && calls.save[0].request === "намалюй деплой" && calls.save[0].language === "auto",
    JSON.stringify(calls.save[0] ?? null).slice(0, 120)
  );
  await run(`document.getElementById("reveal-btn").click()`);
  record(
    "the saved file can be shown in Finder",
    !(await run(`document.getElementById("reveal-btn").hidden`)) && (await run("window.__boardProbe.calls().reveal")) === 1
  );

  // ── Cyrillic font ───────────────────────────────────────────────────────
  const font = await run(`(() => {
    const width = (family) => {
      const span = document.createElement("span");
      span.style.cssText = "position:absolute;visibility:hidden;font-size:40px;font-family:" + family;
      span.textContent = "Щедрий їжак ґаздує";
      document.body.append(span);
      const value = span.getBoundingClientRect().width;
      span.remove();
      return value;
    };
    const label = document.querySelector("#diagram svg .nodeLabel") ?? document.querySelector("#diagram svg text");
    return {
      loaded: document.fonts.check('16px "Fixel"'),
      fixel: width('"Fixel", monospace'),
      fallback: width("monospace"),
      diagramFont: getComputedStyle(label).fontFamily
    };
  })()`);
  record(
    "the bundled font has Cyrillic glyphs",
    font.loaded && Math.abs(font.fixel - font.fallback) > 1,
    `${Math.round(font.fixel)}px vs ${Math.round(font.fallback)}px in the fallback`
  );
  record("diagram labels use the bundled font", font.diagramFont.includes("Fixel"), font.diagramFont);

  // ── Quoting set against the real parser ─────────────────────────────────
  const parsed = await run(`(async () => {
    const mermaid = (await import("./vendor/mermaid/mermaid.esm.min.mjs")).default;
    const attempt = async (source) => {
      try { await mermaid.parse(source); return null; } catch (err) { return String(err?.message ?? err).slice(0, 120); }
    };
    const quoting = ${JSON.stringify(quoting)};
    const out = { valid: [], broken: [] };
    for (const item of quoting.valid) out.valid.push({ name: item.name, error: await attempt(item.source) });
    for (const item of quoting.broken) out.broken.push({ name: item.name, error: await attempt(item.source) });
    return out;
  })()`);
  const rejected = parsed.valid.filter((item) => item.error);
  record(
    "every quoted label in the set parses",
    rejected.length === 0,
    rejected.map((item) => `${item.name}: ${item.error}`).join(" | ")
  );
  const accepted = parsed.broken.filter((item) => !item.error);
  record("unquoted special characters do not parse", accepted.length === 0, accepted.map((item) => item.name).join(", "));

  // ── Pasted Mermaid needs no model ───────────────────────────────────────
  const before = calls.draw.length;
  now = await draw(quoting.valid.find((item) => item.name === "sequence").source);
  calls = await run("window.__boardProbe.calls()");
  record("pasted Mermaid is drawn without a model call", now.svg && now.text.includes("Користувач") && calls.draw.length === before);

  // ── One repair retry ────────────────────────────────────────────────────
  now = await draw("broken diagram please");
  calls = await run("window.__boardProbe.calls()");
  record("a broken diagram is repaired once", now.status === "Done, fixed once" && now.text.includes("Виправлено"), `${now.status} ${now.error}`);
  record(
    "the repair call carries the broken source and Mermaid's error",
    calls.repair.length === 1 && calls.repair[0].source === BROKEN && calls.repair[0].error.length > 0,
    calls.repair[0]?.error.slice(0, 80)
  );
  record("the repaired source replaces the broken one", now.source === FIXED);

  // ── Second failure: last good render stays ──────────────────────────────
  await run(`window.__boardProbe.setRepair("bad")`);
  now = await draw("broken again");
  calls = await run("window.__boardProbe.calls()");
  record("a second failure makes no third model call", calls.repair.length === 2);
  record(
    "the last good diagram stays with one error line",
    now.svg && now.text.includes("Виправлено") && now.source === FIXED && now.error.startsWith("Mermaid could not draw this:") && now.status === "Kept the last diagram",
    `${now.status} | ${now.error.slice(0, 80)}`
  );
  record("a failed diagram leaves no Mermaid error graphic", (await run(`document.querySelectorAll("body > [id^='dboard-diagram'], body > svg").length`)) === 0);

  record("a failed diagram is not saved", calls.save.every((item) => item.source !== BROKEN), `${calls.save.length} saves`);

  // ── Spoken request (./marshal do board …) ───────────────────────────────
  const drawsBefore = calls.draw.length;
  await run(`window.__boardProbe.speak("draw the deploy flow")`);
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    if (!(await state()).busy) break;
  }
  now = await state();
  calls = await run("window.__boardProbe.calls()");
  record(
    "a spoken request draws a board without a click",
    now.svg && now.status === "Done" && now.text.includes("Початок деплою") && calls.draw.length === drawsBefore + 1 &&
      calls.draw.at(-1).text === "draw the deploy flow" && (await run(`document.getElementById("request").value`)) === "draw the deploy flow",
    `${now.status} ${now.error}`
  );
  record("the spoken board is saved too", calls.save.at(-1)?.request === "draw the deploy flow" && calls.save.at(-1)?.source === GOOD);

  // ── Model unavailable ───────────────────────────────────────────────────
  now = await draw("offline request");
  record("a silent model shows its message and keeps the board", now.error === "The model did not answer." && now.svg);

  // ── Brainstorm (./marshal do brainstorm …) ──────────────────────────────
  const MAP = `({
    mode: document.getElementById("board-mode").value,
    roleShown: !document.getElementById("board-role").hidden,
    mapShown: !document.getElementById("map-stage").hidden,
    diagramShown: !document.getElementById("diagram-stage").hidden,
    nodes: [...document.querySelectorAll(".board-node")].map((node) => {
      const box = node.getBoundingClientRect();
      return { id: node.dataset.id, type: node.dataset.type, text: node.querySelector(".board-node-label").textContent,
        border: getComputedStyle(node).borderLeftColor, x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) };
    }),
    edges: document.querySelectorAll("#map-edges path").length,
    edgeLabels: [...document.querySelectorAll("#map-edges text")].map((item) => item.textContent),
    summary: document.getElementById("summary").textContent,
    tasks: [...document.querySelectorAll("#tasks li")].map((item) => item.textContent),
    questionsShown: !document.getElementById("questions-panel").hidden,
    panelsShown: !document.getElementById("panels").hidden,
    button: document.getElementById("draw-btn").textContent,
    request: document.getElementById("request").value
  })`;
  const settle = async () => {
    for (let i = 0; i < 150; i++) {
      await sleep(100);
      if (!(await state()).busy) break;
    }
    return run(MAP);
  };
  const savesBefore = calls.save.length;
  await run(`window.__boardProbe.speak("давай подумаємо про ціни", "brainstorm")`);
  await sleep(250);
  let map = await run(MAP);
  record(
    "a spoken thought switches the board to brainstorm",
    map.mode === "brainstorm" && map.roleShown && map.mapShown && !map.diagramShown && map.button === "Add",
    JSON.stringify({ mode: map.mode, button: map.button })
  );
  record("the first node is drawn while the reply is still streaming", map.nodes.length === 1 && map.nodes[0].id === "root" && (await state()).busy, `${map.nodes.length} nodes`);
  map = await settle();
  now = await state();
  calls = await run("window.__boardProbe.calls()");
  const typeOf = (id) => map.nodes.find((node) => node.id === id);
  record(
    "the map shows typed nodes and edges",
    map.nodes.length === 3 && map.edges === 2 && typeOf("churn")?.type === "risk" && typeOf("survey")?.type === "task" &&
      typeOf("root")?.text === "Ціни на підписку" && map.edgeLabels.join() === "спершу" && now.status === "Done" && now.error === "",
    `${map.nodes.length} nodes, ${map.edges} edges, ${now.status} ${now.error}`
  );
  record("node types have different colours", new Set(map.nodes.map((node) => node.border)).size === 3, map.nodes.map((node) => node.border).join(" "));
  const overlap = (nodes) =>
    nodes.some((a, i) => nodes.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
  record("children sit right of their parent and no cards overlap", !overlap(map.nodes) && typeOf("churn").x > typeOf("root").x);
  record(
    "summary, tasks and questions fill the panels",
    map.panelsShown && map.summary === "Думаємо про ціни." && map.tasks.join() === "Опитати клієнтів" && map.questionsShown
  );
  record(
    "the thought went to the model with the role and the empty board",
    calls.brainstorm.length === 1 && calls.brainstorm[0].role === "both" && calls.brainstorm[0].board.nodes.length === 0 && map.request === "",
    JSON.stringify(calls.brainstorm[0] ?? null).slice(0, 160)
  );
  record(
    "the brainstorm is saved as a board state",
    calls.save.length === savesBefore + 1 && calls.save.at(-1).board?.nodes.length === 3 && calls.save.at(-1).id === undefined &&
      !(await run(`document.getElementById("reveal-btn").hidden`))
  );

  await run(`document.getElementById("board-role").value = "challenge"`);
  await run(`document.getElementById("request").value = "може три тарифи"; document.getElementById("draw-btn").click()`);
  map = await settle();
  calls = await run("window.__boardProbe.calls()");
  record(
    "a second thought grows the same map",
    map.nodes.length === 5 && map.edges === 4 && typeOf("tiers")?.type === "decision" && !overlap(map.nodes) &&
      map.tasks.length === 2 && !map.questionsShown && map.summary.includes("rate limit"),
    `${map.nodes.length} nodes, ${map.edges} edges`
  );
  record(
    "the model gets the board so far and the chosen role, and the same board is rewritten",
    calls.brainstorm.at(-1).board.nodes.length === 3 && calls.brainstorm.at(-1).role === "challenge" && calls.save.at(-1).id === "test" &&
      calls.save.at(-1).board.nodes.length === 5
  );

  await run(`document.getElementById("request").value = "offline thought"; document.getElementById("draw-btn").click()`);
  map = await settle();
  now = await state();
  record("a silent model keeps the map and the typed thought", now.error === "The model did not answer." && map.nodes.length === 5 && map.request === "offline thought");
  await run(`document.getElementById("request").value = "prose only"; document.getElementById("draw-btn").click()`);
  map = await settle();
  now = await state();
  record("a reply without ops changes nothing and says so", now.error.includes("nothing for the map") && map.nodes.length === 5, now.error);

  if (process.env.MARSHAL_E2E_SHOTS) {
    await fs.mkdir(process.env.MARSHAL_E2E_SHOTS, { recursive: true });
    for (const theme of ["dark", "light"]) {
      await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      await sleep(400);
      const image = await win.webContents.capturePage();
      await fs.writeFile(path.join(process.env.MARSHAL_E2E_SHOTS, `board-brainstorm-${theme}.png`), image.toPNG());
    }
  }

  await run(`document.getElementById("clear-btn").click()`);
  map = await run(MAP);
  record("Clear empties the map and its panels", map.nodes.length === 0 && map.edges === 0 && !map.panelsShown && !(await run(`document.getElementById("map-empty").hidden`)));
  await run(`window.__boardProbe.speak("", "diagram")`);
  await sleep(100);
  map = await run(MAP);
  record("the board switches back to a diagram", map.mode === "diagram" && map.diagramShown && !map.mapShown && !map.roleShown && map.button === "Draw");

  if (process.env.MARSHAL_E2E_SHOTS) {
    await fs.mkdir(process.env.MARSHAL_E2E_SHOTS, { recursive: true });
    await draw(GOOD);
    for (const theme of ["dark", "light"]) {
      await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.getElementById("draw-btn").click()`);
      await sleep(1200);
      const image = await win.webContents.capturePage();
      await fs.writeFile(path.join(process.env.MARSHAL_E2E_SHOTS, `board-${theme}.png`), image.toPNG());
    }
  }

  // ── Language and Clear ──────────────────────────────────────────────────
  await run(`window.MarshalI18n.set("uk")`);
  record("the window switches to Ukrainian", (await run(`document.getElementById("draw-btn").textContent`)) === "Намалювати");
  await run(`document.getElementById("clear-btn").click()`);
  now = await state();
  record("Clear empties the board", !now.svg && now.emptyShown && now.source === "" && now.error === "" && (await run(`document.getElementById("reveal-btn").hidden`)));

  record("renderer logged no errors", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 400));

  clearTimeout(watchdog);
  await fs.unlink(preloadPath).catch(() => {});
  win.destroy();
  const failed = Object.entries(checks).filter(([, value]) => !value.passed);
  console.log(`\n[board-e2e] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} checks passed`);
  if (failed.length > 0) console.error(`[board-e2e] failed: ${failed.map(([name]) => name).join(", ")}`);
  app.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[board-e2e] threw:", err);
  app.exit(2);
});
