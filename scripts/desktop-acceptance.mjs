import { _electron as electron } from "playwright";

const LOCAL_EXPECTED = "desktop local ok";
const ATTACHMENT_EXPECTED = "attachment content from desktop acceptance";
const ATTACHMENT_PATH = "/tmp/marshal-desktop-attachment.txt";

const app = await electron.launch({
  args: ["dist/desktop/main.js"],
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" }
});

const page = await app.firstWindow();
await page.waitForLoadState("domcontentloaded");
await page.bringToFront();

page.on("dialog", async (dialog) => {
  if (dialog.type() === "prompt") {
    await dialog.accept("Desktop Acceptance");
    return;
  }

  await dialog.accept();
});

await waitForRenderer(
  page,
  ({ selector, expected }) => ((document.querySelector(selector)?.textContent || "").trim() === expected),
  { selector: "#health-backend", expected: "Connected" },
  30_000
);
console.log("phase=backend-connected");

if ((await page.locator("#project-select option").count()) === 0) {
  await page.click("#new-project-button");
  await waitForRenderer(page, () => document.querySelectorAll("#project-select option").length > 0, 10_000);
}

const projectId = await page.locator("#project-select").evaluate((element) => element.value);
console.log(`phase=project:${projectId}`);

await waitForRenderer(
  page,
  ({ selector }) => ["ready", "connected"].includes((document.querySelector(selector)?.textContent || "").trim()),
  { selector: "#bridge-status" },
  60_000
);
console.log(`phase=bridge:${await page.textContent("#bridge-status")}`);

const existingSessions = await page.evaluate((pid) => window.marshalDesktop.listSessions(pid), projectId);
const existingSessionIds = new Set(existingSessions.map((session) => session.id));

await page.click("#new-session-button");
await waitForRenderer(
  page,
  () => {
    const title = (document.querySelector("#session-title")?.textContent || "").trim();
    return title.length > 0 && title !== "No session selected";
  },
  undefined,
  15_000
);
await page.click("#toggle-events-button");

const sessions = await page.evaluate((pid) => window.marshalDesktop.listSessions(pid), projectId);
const createdSession = sessions.find((session) => !existingSessionIds.has(session.id)) ?? sessions[0];
if (!createdSession) {
  throw new Error("No session was created in the desktop shell.");
}
console.log(`phase=session:${createdSession.id}`);

await page.fill("#task-input", "Reply with exactly: desktop local ok");
await page.selectOption("#route-select", "local");
await page.click("#send-button");
console.log("phase=local-submitted");

const localSession = await waitForTaskResult(page, projectId, createdSession.id, LOCAL_EXPECTED, 240_000);
console.log(`phase=local-complete:${localSession.tasks.at(-1)?.status ?? "unknown"}`);

await page.setInputFiles("#file-input", ATTACHMENT_PATH);
await waitForRenderer(
  page,
  ({ selector, name }) => ((document.querySelector(selector)?.textContent || "").trim().includes(name)),
  { selector: "#attachment-list", name: "marshal-desktop-attachment.txt" },
  10_000
);
await page.fill("#task-input", "Read the attached file and reply with exactly its content.");
await page.selectOption("#route-select", "local");
await page.click("#send-button");
console.log("phase=attachment-submitted");

const attachmentSession = await waitForTaskResult(
  page,
  projectId,
  createdSession.id,
  ATTACHMENT_EXPECTED,
  240_000
);
console.log(`phase=attachment-complete:${attachmentSession.tasks.at(-1)?.status ?? "unknown"}`);

await page.screenshot({ path: "/tmp/marshal-desktop-complete.png" });
console.log(
  JSON.stringify(
    {
      projectId,
      sessionId: createdSession.id,
      sessionTitle: createdSession.title,
      assistantMessages: attachmentSession.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text),
      latestTask: attachmentSession.tasks.at(-1)
    },
    null,
    2
  )
);

await app.close();

async function waitForRenderer(page, predicate, arg, timeoutMs) {
  await page.waitForFunction(predicate, arg, { timeout: timeoutMs });
}

async function waitForTaskResult(page, projectId, sessionId, expectedText, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const session = await page.evaluate(
      ({ pid, sid }) => window.marshalDesktop.readSession({ projectId: pid, sessionId: sid }),
      { pid: projectId, sid: sessionId }
    );
    if (!session) {
      throw new Error(`Desktop session ${sessionId} disappeared.`);
    }

    const assistantMessages = session.messages.filter((message) => message.role === "assistant");
    const lastAssistant = assistantMessages.at(-1)?.text?.trim() || "";
    const lastTask = session.tasks.at(-1) ?? null;

    if (lastAssistant === expectedText) {
      return session;
    }

    if (lastTask?.status === "failed") {
      throw new Error(`Desktop task failed: ${lastTask.error || "unknown error"}`);
    }

    await page.waitForTimeout(2_500);
  }

  throw new Error(`Timed out waiting for desktop task result: ${expectedText}`);
}
