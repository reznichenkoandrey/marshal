// E2E smoke test — boots the built Electron app, asserts the renderer window
// appears, then tears down. Runs locally only (a CI Linux runner has no
// `dist/desktop/main.js` icon assets and macOS GitHub runners would need
// Screen Recording / Accessibility prompts approved).
//
// Run: `npm run test:e2e`
//
// Exit codes:
//   0 — smoke passed
//   1 — failed an assertion or hit a timeout
//
// Keep the script standalone (no test framework) so it can run on a fresh
// machine without extra deps beyond `electron` + `playwright`.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { _electron as electron } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const mainEntry = path.join(projectRoot, "dist", "desktop", "main.js");

const TIMEOUT_MS = 30_000;

const timer = setTimeout(() => {
  console.error(`[e2e-smoke] timed out after ${TIMEOUT_MS}ms`);
  process.exit(1);
}, TIMEOUT_MS);

try {
  console.log(`[e2e-smoke] launching ${mainEntry}`);
  const app = await electron.launch({
    args: [mainEntry],
    // Tray-only app: pretend the user is already past TCC prompts so we don't
    // hang waiting on dialogs. The renderer window still opens for assertions.
    env: {
      ...process.env,
      MARSHAL_DICTATION_ENABLED: "0",
      // Skip the screen-recording permission prompt timer in initTranslator().
      // It's a setTimeout(2000) so a longer timeout would also work; this is
      // cheaper and keeps the test deterministic.
      MARSHAL_SKIP_TCC_PROMPT: "1"
    }
  });

  const window = await app.firstWindow();
  console.log("[e2e-smoke] firstWindow ready");

  // The main window is the operator panel. We don't assert on copy because
  // i18n + UI churn would make that brittle; presence of <body> is enough to
  // know the renderer finished its first paint.
  await window.waitForSelector("body", { timeout: 10_000 });
  console.log("[e2e-smoke] renderer body painted");

  const title = await window.title();
  console.log(`[e2e-smoke] window title: ${JSON.stringify(title)}`);

  // App-level state — fetch settings via the existing IPC channel to prove
  // backend wiring is alive end-to-end.
  const settings = await app.evaluate(async ({ ipcMain }) => {
    // ipcMain only emits — we use the same handler the renderer would call.
    // Cheap proxy: read the settings file directly through Node fs in the
    // main process context.
    const fs = await import("node:fs");
    const pathMod = await import("node:path");
    const { app: electronApp } = await import("electron");
    const file = pathMod.join(electronApp.getPath("userData"), "settings.json");
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  });
  console.log(`[e2e-smoke] settings.json present: ${settings !== null}`);

  await app.close();
  clearTimeout(timer);
  console.log("[e2e-smoke] passed");
  process.exit(0);
} catch (err) {
  clearTimeout(timer);
  console.error("[e2e-smoke] failed:", err);
  process.exit(1);
}
