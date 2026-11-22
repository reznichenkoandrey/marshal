// E2E check of the Decks window in a real Electron renderer (#277).
//
// Loads the shipped window with a stub `window.marshalDecks` and pushes the
// states main would, built by the shipped deck modules: empty, building (one
// slide done, the next growing, the rest still outline titles), ready,
// presenting. The generation itself is covered by tests/decks-generator.test.ts;
// what only a renderer can show is that slides sit in a sandboxed frame, that
// the view follows the build, that keys and buttons work, and that
// printToPDF gives one page per slide.
//
// Run: `npm run test:e2e:decks` (MARSHAL_E2E_SHOTS=<dir> saves screenshots and the PDF)
//
// Exit codes: 0 — every check passed, 1 — a check failed, 2 — the run threw.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow } from "electron";

import { quietApp, showQuietly } from "./quiet-window.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "../..", "dist", "desktop");
const load = (file) => import(pathToFileURL(path.join(DIST, "decks", file)).href);

const checks = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, passed, detail) {
  checks[name] = passed;
  console.log(`[decks-e2e] ${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const PRELOAD = `
const { contextBridge, ipcRenderer } = require("electron");
const calls = [];
contextBridge.exposeInMainWorld("marshalDecks", {
  onState: (cb) => ipcRenderer.on("marshal:decks-state", cb),
  build: (words) => { calls.push({ build: words }); },
  present: (on) => { calls.push({ present: on }); },
  exportDeck: (format) => { calls.push({ exportDeck: format }); return Promise.resolve({ ok: true }); },
  close: () => { calls.push("close"); },
  calls: () => calls.splice(0)
});
`;

const OUTLINE = ["Rate limit у Marshal", "Що це", "Де б'є", "Як обходимо", "Висновки"];
const SLIDES = [
  { layout: "title", html: "<h1>Rate limit у Marshal</h1><p>Коротко про ліміти запитів</p>", notes: "Привітайся і назви тему." },
  { layout: "bullets", html: "<h2>Що це</h2><ul><li>Ліміт запитів за хвилину</li><li>429 і <code>Retry-After</code></li></ul>", notes: "Поясни 429." },
  { layout: "bullets", html: '<h2>Де б\'є</h2><script>window.parent.pwned = 1</script><ul><li onclick="x()">STT субтитрів</li><li>Summary</li></ul>', notes: "Два місця." },
  { layout: "quote", html: "<blockquote>Спершу виміряй, потім обходь.</blockquote>", notes: "Цитата." },
  { layout: "content", html: "<h2>Висновки</h2><p>Бюджет запитів і локальний fallback.</p>", notes: "Підсумок п'ятого слайда." }
];

const read = (win, expression) => win.webContents.executeJavaScript(expression);
const key = (win, name) => read(win, `document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(name)}, bubbles: true }))`);
const VIEW = `({
  rail: [...document.querySelectorAll("#rail button")].map((button) => ({ built: button.dataset.built, current: button.getAttribute("aria-current") === "true", label: button.querySelector(".label").textContent })),
  srcdoc: document.getElementById("frame").srcdoc,
  sandbox: document.getElementById("frame").getAttribute("sandbox"),
  counter: document.getElementById("counter").textContent,
  notes: document.getElementById("notes").textContent,
  title: document.getElementById("deck-title").textContent,
  disabled: Object.fromEntries(["prev-btn", "next-btn", "present-btn", "html-btn", "pdf-btn", "build-btn"].map((id) => [id, document.getElementById(id).disabled])),
  presenting: document.body.dataset.presenting,
  barShown: getComputedStyle(document.querySelector(".bar")).display !== "none",
  frameWidth: Math.round(document.querySelector(".deck-frame").getBoundingClientRect().width)
})`;

/** Distinct colours in the middle of the slide frame: one means nothing was drawn there. */
async function frameColours(win) {
  const box = await read(win, `(() => { const r = document.querySelector(".deck-frame").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 4), y: Math.round(r.y + r.height / 4), width: Math.round(r.width / 2), height: Math.round(r.height / 2) }; })()`);
  const bitmap = (await win.webContents.capturePage(box)).toBitmap();
  const colours = new Set();
  for (let i = 0; i < bitmap.length; i += 4 * 7) colours.add(bitmap.readUInt32LE(i));
  return colours.size;
}

/** A sandboxed frame is its own process: its first paint lands some frames after srcdoc changes. */
async function painted(win) {
  let colours = 0;
  for (let attempt = 0; attempt < 30 && colours <= 8; attempt += 1) {
    await sleep(100);
    colours = await frameColours(win);
  }
  return colours;
}

quietApp(app);
app.on("window-all-closed", () => {});
setTimeout(() => {
  console.error("[decks-e2e] timed out");
  app.exit(1);
}, 60_000).unref?.();

async function main() {
  await app.whenReady();
  const { createDeck, applyDeckOp, buildDeckHtml } = await load("deck-model.js");
  const { deckViewState } = await load("deck-service.js");
  const { renderDeckPdf } = await load("deck-pdf.js");

  let deck = createDeck({ id: "deck-e2e", title: "Rate limit у Marshal", language: "uk", now: 1 });
  const decks = [deck];
  SLIDES.forEach((slide, index) => {
    const applied = applyDeckOp(deck, { op: "slide", index: index + 1, ...slide }, 2);
    if (!applied.ok) throw new Error(applied.reason);
    deck = applied.value;
    decks.push(deck);
  });
  const state = (extra) => ({ ...extra, presenting: extra.presenting ?? false });
  const BUILDING = state(deckViewState(decks[1], { status: "building", outline: OUTLINE, expected: 5, partialHtml: { index: 2, html: "<h2>Що це</h2><ul><li>Ліміт запи" } }));
  const READY = state(deckViewState(deck, { status: "ready" }));

  const preloadPath = path.join(os.tmpdir(), `marshal-decks-preload-${process.pid}.cjs`);
  await fs.writeFile(preloadPath, PRELOAD, "utf8");
  const win = new BrowserWindow({ width: 1100, height: 720, show: false, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const consoleErrors = [];
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });
  await win.loadFile(path.join(DIST, "renderer", "deck.html"));
  showQuietly(win);
  await sleep(300);
  const shots = process.env.MARSHAL_E2E_SHOTS;
  if (shots) await fs.mkdir(shots, { recursive: true });
  const shot = async (name) => {
    await painted(win);
    if (shots) await fs.writeFile(path.join(shots, name), (await win.webContents.capturePage()).toPNG());
  };

  let view = await read(win, VIEW);
  record("an empty window shows the hint and nothing to export", (await read(win, `!document.getElementById("empty").classList.contains("hidden") && document.getElementById("body").classList.contains("hidden")`)) && view.disabled["pdf-btn"] && view.disabled["present-btn"]);

  win.webContents.send("marshal:decks-state", BUILDING);
  await sleep(200);
  view = await read(win, VIEW);
  record("the outline fills the rail before the slides exist", view.rail.length === 5 && view.rail.map((item) => item.built).join() === "true,false,false,false,false" && view.rail[4].label === "Висновки", JSON.stringify(view.rail.map((item) => item.label)));
  record("the view follows the slide being written", view.rail[1].current && view.srcdoc.includes("Ліміт запи") && view.counter === "2 / 5", view.counter);
  record("no export and no second build while building", view.disabled["pdf-btn"] && view.disabled["html-btn"] && view.disabled["build-btn"] && !view.disabled["present-btn"]);
  await shot("deck-building.png");

  win.webContents.send("marshal:decks-state", READY);
  await sleep(200);
  view = await read(win, VIEW);
  record("slides sit in a frame with an empty sandbox", view.sandbox === "" && view.srcdoc.startsWith("<!doctype html>"));
  record("the finished deck can be exported", !view.disabled["pdf-btn"] && !view.disabled["html-btn"] && !view.disabled["build-btn"] && view.title === "Rate limit у Marshal");
  const colours = await painted(win);
  record("the slide is painted inside the frame", view.frameWidth > 400 && colours > 8, `${view.frameWidth}px, ${colours} colours`);

  await key(win, "ArrowRight");
  view = await read(win, VIEW);
  record("ArrowRight goes to the next slide", view.counter === "3 / 5" && view.srcdoc.includes("STT субтитрів") && view.notes === "Два місця.", view.counter);
  record("a script or handler from the model never reaches the frame", !/<script|onclick|pwned/u.test(view.srcdoc) && (await read(win, `window.pwned === undefined`)));
  await key(win, "PageUp");
  await key(win, "ArrowLeft");
  await key(win, "ArrowLeft");
  view = await read(win, VIEW);
  record("going back stops at the first slide", view.counter === "1 / 5" && view.disabled["prev-btn"]);
  await read(win, `document.querySelectorAll("#rail button")[4].click()`);
  view = await read(win, VIEW);
  record("a rail click opens that slide with its notes", view.counter === "5 / 5" && view.notes === "Підсумок п'ятого слайда." && view.disabled["next-btn"]);
  await shot("deck-ready.png");

  await read(win, `window.marshalDecks.calls()`);
  await read(win, `(() => { for (const id of ["present-btn", "html-btn", "pdf-btn"]) document.getElementById(id).click(); const input = document.getElementById("words"); input.value = "  4 слайди про whisper  "; document.getElementById("ask").requestSubmit(); })()`);
  let calls = await read(win, `window.marshalDecks.calls()`);
  record("buttons and the form send their intents", JSON.stringify(calls) === JSON.stringify([{ present: true }, { exportDeck: "html" }, { exportDeck: "pdf" }, { build: "4 слайди про whisper" }]), JSON.stringify(calls));

  win.webContents.send("marshal:decks-state", { ...READY, presenting: true });
  await sleep(200);
  view = await read(win, VIEW);
  record("presenting leaves the slide alone on screen", view.presenting === "true" && !view.barShown && view.frameWidth >= 1000, `${view.frameWidth}px`);
  await shot("deck-presenting.png");
  await key(win, "Escape");
  calls = await read(win, `window.marshalDecks.calls()`);
  record("Escape leaves presenting", JSON.stringify(calls) === JSON.stringify([{ present: false }]), JSON.stringify(calls));

  win.webContents.send("marshal:decks-state", { status: "error", id: null, title: "", language: null, slides: [], partial: null, error: "no-model", presenting: false });
  await sleep(100);
  record("a missing model is explained", /Settings/u.test(await read(win, `document.getElementById("error").textContent`)));

  const pdf = await renderDeckPdf(buildDeckHtml(deck));
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page\b/gu) ?? []).length;
  record("the PDF has one page per slide", pdf.subarray(0, 5).toString() === "%PDF-" && pages === 5, `${pages} pages, ${pdf.length} bytes`);
  if (shots) await fs.writeFile(path.join(shots, "deck.pdf"), pdf);

  record("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
  await fs.rm(preloadPath, { force: true });
  app.exit(Object.values(checks).every(Boolean) ? 0 : 1);
}

main().catch((err) => {
  console.error("[decks-e2e] threw:", err);
  app.exit(2);
});
