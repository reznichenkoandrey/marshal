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
      // Master headless switch — skips dictation, translator, capture, and
      // extension-bridge init so the smoke test never hits Screen Recording
      // / Accessibility / Mic prompts that block headless CI runners.
      MARSHAL_HEADLESS: "1",
      MARSHAL_DICTATION_ENABLED: "0"
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

  // App-level sanity check — read app.getPath("userData") to prove the main
  // process initialised far enough that Electron paths are resolvable. We
  // deliberately avoid `import()` inside the evaluated function: Playwright
  // wraps the body in a synchronous worker that disables dynamic imports.
  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
  console.log(`[e2e-smoke] userData dir: ${userDataDir}`);
  if (!userDataDir) {
    throw new Error("app.getPath('userData') returned empty — main process is not fully booted");
  }

  await app.close();
  clearTimeout(timer);
  console.log("[e2e-smoke] passed");
  process.exit(0);
} catch (err) {
  clearTimeout(timer);
  console.error("[e2e-smoke] failed:", err);
  process.exit(1);
}
