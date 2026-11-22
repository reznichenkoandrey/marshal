// E2E check of the Dashboards window in a real Electron renderer (#279).
//
// Loads the shipped window with a stub `window.marshalDashboards` and pushes
// the states main would: empty, skeletons right after the plan, filled charts,
// an error. The build itself is covered by tests/dashboards.test.ts; what only
// a renderer can show is that cards appear before their data, that the SVG is
// drawn, that a label from a repository cannot inject markup and that the
// form sends the request.
//
// Run: `npm run test:e2e:dashboards` (MARSHAL_E2E_SHOTS=<dir> saves a screenshot)
//
// Exit codes: 0 — every check passed, 1 — a check failed, 2 — the run threw.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.resolve(here, "../..", "dist", "desktop", "renderer");

const checks = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, passed, detail) {
  checks[name] = passed;
  console.log(`[dashboards-e2e] ${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const PRELOAD = `
const { contextBridge, ipcRenderer } = require("electron");
const calls = [];
contextBridge.exposeInMainWorld("marshalDashboards", {
  onState: (cb) => ipcRenderer.on("marshal:dashboards-state", cb),
  build: (prompt) => { calls.push({ build: prompt }); },
  refresh: () => { calls.push("refresh"); },
  pickFolder: () => { calls.push("pickFolder"); },
  close: () => { calls.push("close"); },
  calls: () => calls
});
`;

const days = Array.from({ length: 14 }, (_unused, index) => ({
  label: `2026-11-${String(9 + index).padStart(2, "0")}`,
  value: [3, 5, 2, 0, 0, 7, 9, 4, 6, 1, 0, 0, 8, 12][index]
}));
const plan = [
  { id: "c1", title: "Коміти по днях", kind: "line", source: "git" },
  { id: "c2", title: "PRs by author", kind: "bar", source: "github" }
];
const SKELETON = { folder: "/repo/marshal", busy: true, error: null, dashboard: { title: "Два тижні", prompt: "p", charts: plan.map((chart) => ({ ...chart, status: "pending" })) } };
const FILLED = {
  folder: "/repo/marshal",
  busy: false,
  error: null,
  dashboard: {
    title: "Два тижні",
    prompt: "p",
    charts: [
      { ...plan[0], status: "ready", rows: days, stats: { total: 57, min: 0, max: 12, avg: 4.1 }, updatedAt: new Date().toISOString(), query: { source: "git", metric: "commits", groupBy: "day", days: 14 } },
      {
        ...plan[1],
        status: "ready",
        rows: [{ label: "ann", value: 9 }, { label: '<img src=x onerror="window.pwned=1">', value: 4 }],
        stats: { total: 13, min: 4, max: 9, avg: 6.5 },
        updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        query: { source: "github", metric: "prs", groupBy: "author", days: 14 }
      }
    ]
  }
};

const read = (win, expression) => win.webContents.executeJavaScript(expression);
const CARDS = `[...document.querySelectorAll(".chart-card")].map((card) => ({
  status: card.dataset.status,
  title: card.querySelector("h3").textContent,
  svg: card.querySelector("svg") !== null,
  width: card.querySelector(".chart-body").getBoundingClientRect().width,
  foot: card.querySelector(".chart-foot").textContent
}))`;

app.on("window-all-closed", () => {});
setTimeout(() => {
  console.error("[dashboards-e2e] timed out");
  app.exit(1);
}, 60_000).unref?.();

async function main() {
  await app.whenReady();
  app.dock?.hide();
  const preloadPath = path.join(os.tmpdir(), `marshal-dashboards-preload-${process.pid}.cjs`);
  await fs.writeFile(preloadPath, PRELOAD, "utf8");
  const win = new BrowserWindow({ width: 1100, height: 720, show: false, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const consoleErrors = [];
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });
  await win.loadFile(path.join(RENDERER, "dashboards.html"));
  await sleep(300);

  record("an empty window shows the hint", await read(win, `!document.getElementById("empty").classList.contains("hidden")`));

  win.webContents.send("marshal:dashboards-state", SKELETON);
  await sleep(200);
  let cards = await read(win, CARDS);
  record("the plan draws a skeleton per chart before any data", cards.length === 2 && cards.every((card) => card.status === "pending" && !card.svg));
  record("Build is disabled while a build runs", await read(win, `document.getElementById("build-btn").disabled`));

  win.webContents.send("marshal:dashboards-state", FILLED);
  await sleep(200);
  cards = await read(win, CARDS);
  record("filled charts draw an SVG", cards.every((card) => card.svg && card.width > 200), cards.map((card) => Math.round(card.width)).join(", "));
  record("the line chart has one point per day", (await read(win, `document.querySelectorAll(".chart-card")[0].querySelectorAll("circle").length`)) === 14);
  record("stats and age are shown", /57/u.test(cards[0].foot) && /3 h/u.test(cards[1].foot), cards[1].foot);
  record("a repository label cannot inject markup", (await read(win, `window.pwned === undefined && document.querySelector(".chart-card img") === null`)) === true);
  record("the dashboard title is shown", (await read(win, `document.getElementById("board-title").textContent`)) === "Два тижні");

  await read(win, `(() => { const input = document.getElementById("prompt"); input.value = "  issues by label  "; document.getElementById("ask").requestSubmit(); document.getElementById("refresh-btn").click(); })()`);
  const calls = await read(win, `window.marshalDashboards.calls()`);
  record("the form sends the trimmed request, Refresh sends refresh", JSON.stringify(calls) === JSON.stringify([{ build: "issues by label" }, "refresh"]), JSON.stringify(calls));

  win.webContents.send("marshal:dashboards-state", { ...FILLED, error: "Choose a repository folder first." });
  await sleep(100);
  record("an error is shown", (await read(win, `document.getElementById("error").textContent`)) === "Choose a repository folder first.");
  record("the bar buttons carry their icons", (await read(win, `document.querySelectorAll(".bar-actions .icon-btn svg").length`)) === 3);
  record("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));

  if (process.env.MARSHAL_E2E_SHOTS) {
    win.webContents.send("marshal:dashboards-state", FILLED);
    await sleep(200);
    await fs.mkdir(process.env.MARSHAL_E2E_SHOTS, { recursive: true });
    await fs.writeFile(path.join(process.env.MARSHAL_E2E_SHOTS, "dashboards.png"), (await win.webContents.capturePage()).toPNG());
  }
  await fs.rm(preloadPath, { force: true });
  app.exit(Object.values(checks).every(Boolean) ? 0 : 1);
}

main().catch((err) => {
  console.error("[dashboards-e2e] threw:", err);
  app.exit(2);
});
