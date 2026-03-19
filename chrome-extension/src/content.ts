type BridgeCommand = {
  id: string;
  kind: "send_prompt" | "reset_conversation" | "debug_snapshot";
  payload: Record<string, unknown>;
};

type CommandResult = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
};

const POLL_INTERVAL_MS = 1500;

void sendTick();
window.setInterval(() => {
  void sendTick();
}, POLL_INTERVAL_MS);

function sendTick(): Promise<void> {
  return chrome.runtime.sendMessage({
    type: "marshal-tick",
    state: collectPageState()
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "marshal-command") {
    return;
  }

  void executeCommand(message.command as BridgeCommand)
    .then((result) => sendResponse(result))
    .catch((error: unknown) => {
      const text = error instanceof Error ? error.message : "Unknown content script error.";
      sendResponse({ ok: false, error: text } satisfies CommandResult);
    });

  return true;
});

async function executeCommand(command: BridgeCommand): Promise<CommandResult> {
  switch (command.kind) {
    case "reset_conversation":
      await ensureProjectSelected(typeof command.payload.projectName === "string" ? command.payload.projectName : "");
      await resetConversation();
      return { ok: true, data: { state: collectPageState().state } };
    case "send_prompt": {
      const prompt = String(command.payload.prompt ?? "").trim();
      const responseMode =
        command.payload.responseMode === "ready_surface" ? "ready_surface" : "assistant_text";
      if (!prompt) {
        return { ok: false, error: "Prompt is empty." };
      }

      await ensureProjectSelected(typeof command.payload.projectName === "string" ? command.payload.projectName : "");

      if (collectPageState().state !== "ready") {
        return { ok: false, error: "ChatGPT is not on a ready composer surface." };
      }

      const previous = extractLatestAssistantText();
      const composer = resolveComposer();
      if (!composer) {
        return { ok: false, error: "Unable to resolve the ChatGPT composer." };
      }
      setComposerText(composer, prompt);
      await submitComposer(composer, prompt);
      if (responseMode === "ready_surface") {
        await waitForReadySurface(120_000);
        return { ok: true, data: { state: collectPageState().state } };
      }
      const responseText = await waitForStableAssistantText(previous);
      return { ok: true, data: { responseText } };
    }
    case "debug_snapshot":
      return {
        ok: true,
        data: {
          snapshot: collectDebugSnapshot()
        }
      };
    default:
      return { ok: false, error: `Unsupported extension command: ${command.kind}` };
  }
}

function collectPageState(): { url: string; title: string; state: string } {
  return {
    url: window.location.href,
    title: document.title,
    state: detectPageState()
  };
}

function detectPageState(): string {
  if (/auth\.openai\.com|accounts\.google\.com/.test(window.location.href)) {
    return "auth";
  }

  if (isLoggedOutHomepage()) {
    return "logged-out";
  }

  if (resolveComposer({ throwOnFailure: false })) {
    return "ready";
  }

  return "unknown";
}

function isLoggedOutHomepage(): boolean {
  const loginButtons = findElementsWithText("button, a", /(log in|sign in|увійти)/i);
  const signupButtons = findElementsWithText("button, a", /(sign up|зареєструватися)/i);
  return loginButtons.length > 0 && signupButtons.length > 0;
}

function resolveComposer(options: { throwOnFailure?: boolean } = {}): HTMLElement | null {
  const candidates = [
    ...queryVisible('[role="textbox"][contenteditable="true"]'),
    ...queryVisible('[role="textbox"]'),
    ...queryVisible('textarea'),
    ...queryVisible('[contenteditable="true"]'),
    ...queryVisible('input[placeholder]')
  ]
    .filter(isPromptLikeComposer)
    .sort((left, right) => scoreComposerCandidate(right) - scoreComposerCandidate(left));

  const composer = candidates[0] ?? null;
  if (!composer && options.throwOnFailure !== false) {
    throw new Error("Unable to resolve the ChatGPT composer.");
  }

  return composer;
}

function isPromptLikeComposer(element: HTMLElement): boolean {
  const label = getElementLabelText(element);
  if (/(message|ask|chat|anything|запитайте|повідомлення)/i.test(label)) {
    return true;
  }

  const container = element.closest("form, main, [role='main']");
  if (!container) {
    return false;
  }

  const actionButtons = Array.from(container.querySelectorAll("button,[role='button']")).filter((candidate) =>
    isVisible(candidate)
  );
  return actionButtons.length > 0;
}

function scoreComposerCandidate(element: HTMLElement): number {
  const label = getElementLabelText(element);
  let score = 0;

  if (/(message|ask|chat|anything|запитайте|повідомлення)/i.test(label)) {
    score += 10;
  }

  if (element instanceof HTMLTextAreaElement) {
    score += 4;
  }

  if (element.getAttribute("contenteditable") === "true") {
    score += 3;
  }

  if (element.closest("form")) {
    score += 3;
  }

  if (element.closest("main, [role='main']")) {
    score += 2;
  }

  return score;
}

function getElementLabelText(element: HTMLElement): string {
  return [
    element.getAttribute("aria-label") ?? "",
    element.getAttribute("placeholder") ?? "",
    element.textContent ?? ""
  ]
    .join(" ")
    .toLowerCase();
}

function queryVisible(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(selector)).filter(isVisible) as HTMLElement[];
}

function isVisible(element: Element): boolean {
  const node = element as HTMLElement;
  const style = window.getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function setComposerText(composer: HTMLElement, text: string): void {
  composer.focus();

  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    composer.value = text;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  composer.textContent = text;
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
}

async function submitComposer(composer: HTMLElement, prompt: string): Promise<void> {
  const previousValue = readComposerText(composer);
  const previousUrl = window.location.href;
  await sleep(150);
  composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  composer.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", bubbles: true }));
  composer.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));

  await sleep(250);

  if (didComposerSubmit(composer, previousValue, prompt)) {
    return;
  }

  const sendButton = await waitForSendButton(composer);
  sendButton?.click();
  await sleep(250);

  if (didComposerSubmit(composer, previousValue, prompt)) {
    return;
  }

  const enclosingForm = composer.closest("form");
  if (enclosingForm && typeof enclosingForm.requestSubmit === "function") {
    const submitter =
      sendButton instanceof HTMLButtonElement &&
      sendButton.type === "submit" &&
      sendButton.form === enclosingForm
        ? sendButton
        : undefined;
    enclosingForm.requestSubmit(submitter);
    await sleep(250);
  }

  if (await waitForPromptSubmission(composer, previousValue, prompt, previousUrl)) {
    return;
  }

  throw new Error("The ChatGPT composer did not submit the prompt.");
}

async function resetConversation(): Promise<void> {
  const newChat = findElementsWithText(
    'a,button,[role="button"]',
    /(new chat|new conversation|новий чат)/i
  )[0];

  if (!newChat) {
    throw new Error("Unable to locate the New chat control.");
  }

  newChat.click();
  await sleep(500);
}

async function ensureProjectSelected(projectName: string): Promise<void> {
  const normalizedProjectName = normalizeComparableText(projectName);
  if (!normalizedProjectName) {
    return;
  }

  if (isProjectCurrentlySelected(normalizedProjectName)) {
    return;
  }

  expandProjectsSectionIfNeeded();

  const projectEntry = findSidebarProjectEntry(normalizedProjectName);
  if (!projectEntry) {
    throw new Error(`ChatGPT project "${projectName}" was not found in the sidebar.`);
  }

  projectEntry.click();
  await waitForReadySurface();
}

function extractLatestAssistantText(): string {
  const main = document.querySelector("main");
  const assistantMessages = getVisibleConversationTexts(main, "[data-message-author-role='assistant']");

  if (assistantMessages.length > 0) {
    return assistantMessages[assistantMessages.length - 1];
  }

  if (!main) {
    return "";
  }

  const articles = getVisibleConversationTexts(main, "article");

  return articles[articles.length - 1] ?? "";
}

async function waitForStableAssistantText(previousText: string): Promise<string> {
  let stableReads = 0;
  let lastValue = "";
  const startedAt = Date.now();

  while (Date.now() - startedAt < 60_000) {
    const current = extractLatestAssistantText();
    if (current && current !== previousText && current === lastValue) {
      stableReads += 1;
      if (stableReads >= 3) {
        return current;
      }
    } else {
      stableReads = 1;
      lastValue = current;
    }

    await sleep(400);
  }

  if (lastValue) {
    return lastValue;
  }

  throw new Error("Timed out while waiting for a stable assistant response.");
}

function findElementsWithText(selector: string, pattern: RegExp): HTMLElement[] {
  return Array.from(document.querySelectorAll(selector)).filter((element) => {
    if (!isVisible(element)) {
      return false;
    }

    const text = [
      element.textContent ?? "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("title") ?? ""
    ].join(" ");

    return pattern.test(text);
  }) as HTMLElement[];
}

function findSidebarProjectEntry(normalizedProjectName: string): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll("a,button,[role='button']")).filter((element) => {
    if (!isVisible(element)) {
      return false;
    }

    const container = element.closest("nav, aside, [data-testid*='sidebar'], [class*='sidebar']");
    if (!container) {
      return false;
    }

    const text = normalizeComparableText(
      [
        element.textContent ?? "",
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("title") ?? ""
      ].join(" ")
    );

    return text === normalizedProjectName;
  }) as HTMLElement[];

  return candidates[0] ?? null;
}

function isProjectCurrentlySelected(normalizedProjectName: string): boolean {
  const candidates = Array.from(
    document.querySelectorAll("main h1, main h2, nav a, nav button, aside a, aside button")
  ) as HTMLElement[];

  return candidates.some((element) => {
    if (!isVisible(element)) {
      return false;
    }

    const text = normalizeComparableText(
      [element.textContent ?? "", element.getAttribute("aria-label") ?? ""].join(" ")
    );

    return text === normalizedProjectName && element.getAttribute("aria-current") === "page";
  });
}

function expandProjectsSectionIfNeeded(): void {
  const toggle = findElementsWithText("button,[role='button']", /(projects|проекти|проєкти)/i)[0];
  if (!toggle) {
    return;
  }

  if (toggle.getAttribute("aria-expanded") === "false") {
    toggle.click();
  }
}

async function waitForReadySurface(timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (detectPageState() === "ready") {
      return;
    }

    await sleep(250);
  }

  throw new Error("Timed out while waiting for the selected ChatGPT project to load.");
}

function normalizeText(value: string): string {
  return value.replace(/\u200b/g, "").replace(/\s+\n/g, "\n").replace(/\s+/g, " ").trim();
}

function normalizeComparableText(value: string): string {
  return normalizeText(value).toLowerCase();
}

function resolveSendButton(composer?: HTMLElement | null): HTMLElement | null {
  const scopedContainers = [composer?.closest("form"), composer?.parentElement, composer?.closest("main"), document]
    .filter(Boolean) as ParentNode[];
  const selectors = [
    'button[type="submit"]',
    '[data-testid*="send"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[title*="Send"]',
    'button[title*="send"]',
    'button[aria-label*="Надісл"]',
    'button[aria-label*="Відправ"]'
  ];

  for (const container of scopedContainers) {
    for (const selector of selectors) {
      const candidate = Array.from(container.querySelectorAll(selector))
        .filter((element) => isVisible(element))
        .map((element) => element as HTMLElement)
        .find((element) => !isDisabledElement(element));
      if (candidate) {
        return candidate;
      }
    }
  }

  return findElementsWithText("main button,main [role='button']", /(send|submit|надіслати|відправити)/i).find(
    (element) => !isDisabledElement(element)
  ) ?? null;
}

function readComposerText(composer: HTMLElement): string {
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    return composer.value.trim();
  }

  return normalizeText(composer.innerText || composer.textContent || "");
}

function didComposerSubmit(composer: HTMLElement, previousValue: string, prompt: string): boolean {
  const currentValue = readComposerText(composer);
  const normalizedCurrent = normalizeComparableText(currentValue);
  const normalizedPrompt = normalizeComparableText(prompt);
  const normalizedPrevious = normalizeComparableText(previousValue);

  if (!normalizedCurrent) {
    return true;
  }

  if (normalizedCurrent !== normalizedPrompt && normalizedCurrent !== normalizedPrevious) {
    return true;
  }

  return false;
}

async function waitForSendButton(composer: HTMLElement, timeoutMs = 3_000): Promise<HTMLElement | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const button = resolveSendButton(composer);
    if (button) {
      return button;
    }

    await sleep(100);
  }

  return null;
}

async function waitForPromptSubmission(
  composer: HTMLElement,
  previousValue: string,
  prompt: string,
  previousUrl: string,
  timeoutMs = 5_000
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (window.location.href !== previousUrl || didComposerSubmit(composer, previousValue, prompt)) {
      return true;
    }

    await sleep(100);
  }

  return false;
}

function isDisabledElement(element: HTMLElement): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function collectDebugSnapshot(): Record<string, unknown> {
  const main = document.querySelector("main");
  const assistantMessages = getVisibleConversationTexts(main, "[data-message-author-role='assistant']");
  const articles = getVisibleConversationTexts(main, "article");
  const composer = resolveComposer({ throwOnFailure: false });
  const composerContainer = composer?.closest("form") ?? composer?.parentElement ?? null;
  const buttons = queryVisible("button,[role='button']")
    .map((element) => normalizeText([
      element.textContent ?? "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("title") ?? ""
    ].join(" ")))
    .filter(Boolean)
    .slice(0, 30);
  const composerButtons = composerContainer
    ? Array.from(composerContainer.querySelectorAll("button,[role='button']"))
        .filter((element) => isVisible(element))
        .map((element) => {
          const node = element as HTMLElement;
          return {
            text: normalizeText([
              node.textContent ?? "",
              node.getAttribute("aria-label") ?? "",
              node.getAttribute("title") ?? ""
            ].join(" ")),
            type: node instanceof HTMLButtonElement ? node.type || "button" : node.getAttribute("role") || "",
            disabled: isDisabledElement(node),
            testId: node.getAttribute("data-testid") ?? ""
          };
        })
        .slice(0, 10)
    : [];

  return {
    url: window.location.href,
    title: document.title,
    state: detectPageState(),
    composerText: composer ? readComposerText(composer) : "",
    composerTag: composer?.tagName ?? "",
    composerAriaLabel: composer?.getAttribute("aria-label") ?? "",
    composerContainerTag: composerContainer instanceof HTMLElement ? composerContainer.tagName : "",
    composerButtons,
    assistantMessagesCount: assistantMessages.length,
    lastAssistantMessage: assistantMessages.at(-1) ?? "",
    articlesCount: articles.length,
    lastArticle: articles.at(-1) ?? "",
    mainTextSample: normalizeText((main as HTMLElement | null)?.innerText || "").slice(0, 2000),
    visibleButtons: buttons
  };
}

function getVisibleConversationTexts(root: ParentNode | null, selector: string): string[] {
  if (!root) {
    return [];
  }

  return Array.from(root.querySelectorAll(selector))
    .filter((element) => isVisible(element))
    .map((element) => normalizeText((element as HTMLElement).innerText || element.textContent || ""))
    .filter(Boolean);
}
