// E2E check of the alternatives popover in a real Electron renderer (#146).
//
// Loads the shipped translator window with a stub `window.marshalTranslator`
// and drives it with real mouse and keyboard input
// (`webContents.sendInputEvent`) rather than by poking its internals — so a
// click lands the same way a user's pointer does, through hit-testing, the
// selection check and the outside-click handler.
//
// The stub is the point: the unit tests cover tokenizing, sentence ranges and
// parsing, but nothing there can catch a word span that is not clickable, a
// popover positioned outside the pane, or a chosen alternative that rewrites
// the wrong part of the text. No API key, no network, no model.
//
// Run: `npm run test:e2e:alternatives`
//
// Exit codes:
//   0 — every check passed
//   1 — a check failed (the report names which)
//   2 — the run threw before finishing

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RENDERER = path.join(ROOT, "dist", "desktop", "renderer");

const SOURCE_TEXT = "The first sentence. The second sentence is here. The third.";
const TRANSLATION = "Перше речення. Друге речення тут. Третє.";
const ALTERNATIVE = { word: "друге", sentence: "Друге речення саме тут." };

const checks = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, passed, detail) {
  checks[name] = { passed, detail };
  console.log(`[alt-e2e] ${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** A stub preload: the renderer's whole IPC surface, answered locally. */
function preloadSource() {
  return `
const { contextBridge } = require("electron");

const noopListener = () => () => {};
const languages = [
  { code: "en", name: "English", native: "English" },
  { code: "uk", name: "Ukrainian", native: "Українська" }
];

let alternativesCalls = 0;
let lastPayload = null;

contextBridge.exposeInMainWorld("marshalTranslator", {
  getLanguages: async () => ({
    languages,
    sourceLang: "auto",
    targetLang: "uk",
    formality: "default",
    pinned: false
  }),
  translateText: async () => ({
    translation: ${JSON.stringify(TRANSLATION)},
    sourceLang: "en",
    targetLang: "uk"
  }),
  translateImage: async () => ({ translation: "", sourceLang: "auto", targetLang: "uk" }),
  suggestAlternatives: async (payload) => {
    alternativesCalls += 1;
    lastPayload = { sentence: payload.sentence, word: payload.word, wordOffset: payload.wordOffset };
    return { alternatives: [${JSON.stringify(ALTERNATIVE)}] };
  },
  captureScreen: async () => "",
  close: async () => {},
  setPair: async (options) => options,
  setHasContent: async () => {},
  setPinned: async () => {},
  insertTranslation: async () => {},
  listGlossary: async () => [],
  addGlossaryEntry: async () => [],
  removeGlossaryEntry: async () => [],
  listHistory: async () => [],
  pushHistory: async () => [],
  clearHistory: async () => [],
  onLoading: noopListener,
  onResult: noopListener,
  onError: noopListener,
  onNotice: noopListener,
  onCropInit: noopListener,
  selectCrop: () => {},
  cancelCrop: () => {}
});

// The stub lives in the isolated world, so its counters have to be exposed
// through contextBridge too: a plain assignment onto the window object here
// is invisible to the page.
contextBridge.exposeInMainWorld("__altProbe", {
  calls: () => alternativesCalls,
  lastPayload: () => lastPayload
});
`;
}

async function click(win, at) {
  win.webContents.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await sleep(30);
  win.webContents.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await sleep(200);
}

/** Centre of the first `.tw` span whose text is `word`, in window coordinates. */
function wordCentreScript(word) {
  return `(() => {
    const span = [...document.querySelectorAll(".tw")].find((s) => s.textContent === ${JSON.stringify(word)});
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
}

app.on("window-all-closed", () => {});

async function main() {
  await app.whenReady();

  const preloadPath = path.join(os.tmpdir(), `marshal-alt-preload-${process.pid}.cjs`);
  await fs.writeFile(preloadPath, preloadSource(), "utf8");

  const win = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  });

  const consoleErrors = [];
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  await win.loadFile(path.join(RENDERER, "translator.html"));
  await sleep(400);

  // ── Translate, so the target pane holds a known translation ──
  await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById("input-text");
    input.value = ${JSON.stringify(SOURCE_TEXT)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await sleep(1200); // debounce (650 ms) + the stubbed round trip

  const paneText = await win.webContents.executeJavaScript(
    `document.getElementById("result-text").textContent`
  );
  record(
    "translation rendered verbatim",
    paneText === TRANSLATION,
    JSON.stringify(paneText)
  );

  const wordCount = await win.webContents.executeJavaScript(
    `document.querySelectorAll("#result-text .tw").length`
  );
  record("words are clickable spans", wordCount === 6, `${wordCount} spans`);

  // ── Click the word "Друге" ──
  const target = await win.webContents.executeJavaScript(wordCentreScript("Друге"));
  if (!target) {
    record("word span found", false, "no span with the expected text");
    await finish(win, preloadPath);
    return;
  }
  await click(win, target);
  await sleep(300);

  const popover = await win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById("alt-popover");
    const options = [...el.querySelectorAll(".alt-option .alt-word")].map((n) => n.textContent);
    const rect = el.getBoundingClientRect();
    const body = document.getElementById("result-text").parentElement.getBoundingClientRect();
    return {
      hidden: el.hidden,
      options,
      insidePane: rect.left >= body.left - 1 && rect.right <= body.right + 1,
      payload: window.__altProbe.lastPayload(),
      calls: window.__altProbe.calls()
    };
  })()`);

  record("popover opens on a word click", popover.hidden === false, JSON.stringify(popover.options));
  record(
    "popover stays inside the pane",
    popover.insidePane === true,
    `left/right within the result body: ${popover.insidePane}`
  );
  record(
    "request carries the sentence, not the whole text",
    popover.payload?.sentence === "Друге речення тут." && popover.payload?.word === "Друге",
    JSON.stringify(popover.payload && { sentence: popover.payload.sentence, word: popover.payload.word })
  );

  // ── Choose the alternative ──
  const optionCentre = await win.webContents.executeJavaScript(`(() => {
    const option = document.querySelector("#alt-popover .alt-option");
    if (!option) return null;
    const r = option.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (optionCentre) await click(win, optionCentre);
  await sleep(300);

  const afterPick = await win.webContents.executeJavaScript(
    `document.getElementById("result-text").textContent`
  );
  record(
    "chosen alternative rewrites only its sentence",
    afterPick === "Перше речення. Друге речення саме тут. Третє.",
    JSON.stringify(afterPick)
  );
  record(
    "popover closes after a pick",
    (await win.webContents.executeJavaScript(`document.getElementById("alt-popover").hidden`)) === true
  );

  // ── Re-open the same word: the answer must come from the cache ──
  const reopened = await win.webContents.executeJavaScript(wordCentreScript("Друге"));
  if (reopened) await click(win, reopened);
  await sleep(300);
  const callsAfterReopen = await win.webContents.executeJavaScript(`window.__altProbe.calls()`);
  record(
    "re-opening a clicked word does not repeat the request",
    callsAfterReopen === 2,
    `${callsAfterReopen} calls (1 for "Друге", 1 for the same word in the rewritten sentence)`
  );

  // ── Escape closes it ──
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await sleep(200);
  record(
    "Escape closes the popover",
    (await win.webContents.executeJavaScript(`document.getElementById("alt-popover").hidden`)) === true
  );

  record("renderer logged no errors", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 300));

  await finish(win, preloadPath);
}

async function finish(win, preloadPath) {
  await fs.unlink(preloadPath).catch(() => {});
  win.destroy();

  const failed = Object.entries(checks).filter(([, value]) => !value.passed);
  console.log(`\n[alt-e2e] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} checks passed`);
  if (failed.length > 0) {
    console.error(`[alt-e2e] failed: ${failed.map(([name]) => name).join(", ")}`);
    app.exit(1);
    return;
  }
  app.exit(0);
}

main().catch((err) => {
  console.error("[alt-e2e] threw:", err);
  app.exit(2);
});
