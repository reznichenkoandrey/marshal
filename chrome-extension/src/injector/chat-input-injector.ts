// Content script injected into provider iframes (all_frames: true).
// Communicates with sidepanel via chrome.runtime.connect port through background broker.

if (window.self === window.top) {
  // Top-level frame — do not interfere with existing bridge content.ts
} else {
  setupInjector();
}

function setupInjector(): void {
  // -- Connect to background broker --
  const port = chrome.runtime.connect({ name: "marshal-injector" });

  port.onMessage.addListener((msg: Record<string, unknown>) => {
    const action = msg.action as string;
    if (action === "marshal:sendPrompt") {
      void handleSendPrompt(String(msg.text ?? ""), msg.screenshot as string | undefined);
    }
    if (action === "marshal:readResponse") {
      void handleReadResponse(Number(msg.timeoutMs ?? 60000));
    }
    if (action === "marshal:pasteToChat") {
      const text = String(msg.text ?? "");
      const success = text ? insertText(text) : false;
      reply({ action: "marshal:pasteToChatResult", success });
    }
  });

  function reply(data: Record<string, unknown>): void {
    try { port.postMessage(data); } catch { /* port disconnected */ }
  }

  // -- Provider configs --

  type ProviderConfig = {
    composerType: "contenteditable" | "textarea";
    composerSelectors: string[];
    sendButtonSelectors: string[];
  };

  const PROVIDERS: Record<string, ProviderConfig> = {
    "chatgpt.com": {
      composerType: "contenteditable",
      composerSelectors: [
        "#prompt-textarea",
        '[contenteditable="true"][data-placeholder]',
        '[role="textbox"][contenteditable="true"]',
        '[contenteditable="true"]'
      ],
      sendButtonSelectors: [
        'button[data-testid="send-button"]',
        'button[data-testid*="send"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="send"]'
      ]
    },
    "claude.ai": {
      composerType: "contenteditable",
      composerSelectors: [
        'div.ProseMirror[contenteditable="true"]',
        'div[contenteditable="true"][data-placeholder]',
        'fieldset div[contenteditable="true"]',
        '[contenteditable="true"]'
      ],
      sendButtonSelectors: [
        'button[aria-label*="Send"]',
        'button[aria-label*="send"]',
        'fieldset button:not([disabled])'
      ]
    },
    "gemini.google.com": {
      composerType: "contenteditable",
      composerSelectors: [
        'div.ql-editor.textarea[contenteditable="true"]',
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div[contenteditable="true"]',
        '[contenteditable="true"]'
      ],
      sendButtonSelectors: [
        'button[aria-label*="Send"]',
        'button[aria-label*="send"]',
        '.send-button'
      ]
    }
  };

  // -- Send Prompt: insert text + press Send --

  async function handleSendPrompt(text: string, screenshot?: string): Promise<void> {
    if (!text) {
      reply({ action: "marshal:sendComplete", success: false, error: "Empty prompt" });
      return;
    }

    const config = getProviderConfig();
    const composer = findElement(config?.composerSelectors ?? genericSelectors());
    if (!composer) {
      reply({ action: "marshal:sendComplete", success: false, error: "Composer not found" });
      return;
    }

    // Paste screenshot if provided
    if (screenshot) {
      await pasteScreenshot(composer, screenshot);
      await sleep(500);
    }

    // Insert text
    const ok = insertTextInto(composer, config?.composerType ?? "contenteditable", text);
    if (!ok) {
      reply({ action: "marshal:sendComplete", success: false, error: "Text insertion failed" });
      return;
    }

    // Wait for framework to register input
    await sleep(800);

    // Press Send
    await pressSendButton(composer, config);
    await sleep(500);

    reply({ action: "marshal:sendComplete", success: true });
  }

  // -- Read Response: poll for stable AI answer --

  async function handleReadResponse(timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    let stableReads = 0;
    let lastText = "";

    await sleep(1000);

    while (Date.now() - startedAt < timeoutMs) {
      if (isStreaming()) {
        stableReads = 0;
        await sleep(800);
        continue;
      }

      const messages = getAssistantMessages();
      const currentText = messages.length > 0 ? messages[messages.length - 1] : "";

      if (currentText && currentText.length > 5) {
        if (currentText === lastText) {
          stableReads++;
          if (stableReads >= 2) {
            reply({ action: "marshal:responseReady", success: true, text: currentText });
            return;
          }
        } else {
          stableReads = 0;
          lastText = currentText;
        }
      }

      await sleep(600);
    }

    if (lastText) {
      reply({ action: "marshal:responseReady", success: true, text: lastText, timedOut: true });
    } else {
      reply({ action: "marshal:responseReady", success: false, error: "No assistant messages found" });
    }
  }

  // -- Assistant message reading --

  function getAssistantMessages(): string[] {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '.markdown.prose',
      '.markdown',
      'article',
      '.font-claude-message',
      '[data-testid="chat-message-content"]',
      '.model-response-text',
      '[role="article"]'
    ];

    for (const selector of selectors) {
      try {
        const els = document.querySelectorAll(selector);
        const texts = Array.from(els)
          .filter((el) => isVisible(el as HTMLElement))
          .map((el) => normalize((el as HTMLElement).innerText || el.textContent || ""))
          .filter((t) => t.length > 5);
        if (texts.length > 0) return texts;
      } catch { /* skip */ }
    }
    return [];
  }

  function isStreaming(): boolean {
    const selectors = [
      'button[data-testid*="stop"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
      '[data-is-streaming="true"]',
      '.result-streaming'
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el as HTMLElement) && !isDisabled(el as HTMLElement)) return true;
      } catch { /* skip */ }
    }
    return false;
  }

  // -- Send button --

  async function pressSendButton(composer: HTMLElement, config: ProviderConfig | null): Promise<void> {
    const selectors = [
      ...(config?.sendButtonSelectors ?? []),
      'button[data-testid="send-button"]',
      'button[data-testid*="send"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[title*="Send"]',
      'button[type="submit"]'
    ];

    // Wait up to 3s for send button to enable
    const start = Date.now();
    while (Date.now() - start < 3000) {
      let btn = findElement(selectors);
      if (!btn) {
        const container = composer.closest("form") ?? composer.closest("main");
        if (container) btn = findWithin(container, selectors);
      }
      if (btn && !isDisabled(btn)) {
        activate(btn);
        return;
      }
      await sleep(200);
    }

    // Fallback: Enter key
    composer.focus();
    composer.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true
    }));
    await sleep(50);
    composer.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true
    }));
  }

  // -- Text insertion --

  function insertText(text: string): boolean {
    const config = getProviderConfig();
    const el = findElement(config?.composerSelectors ?? genericSelectors());
    if (!el) return false;
    return insertTextInto(el, config?.composerType ?? "contenteditable", text);
  }

  function insertTextInto(el: HTMLElement, type: string, text: string): boolean {
    return type === "textarea"
      ? setTextarea(el as HTMLTextAreaElement, text)
      : setContentEditable(el, text);
  }

  function setContentEditable(el: HTMLElement, text: string): boolean {
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    try {
      if (document.execCommand("insertText", false, text) && has(el, text)) {
        fire(el, text);
        return true;
      }
    } catch { /* fallthrough */ }
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
      if (has(el, text)) return true;
    } catch { /* fallthrough */ }
    const p = document.createElement("p");
    p.textContent = text;
    el.appendChild(p);
    fire(el, text);
    return has(el, text);
  }

  function setTextarea(ta: HTMLTextAreaElement, text: string): boolean {
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(ta, text); else ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // -- Screenshot paste --

  async function pasteScreenshot(composer: HTMLElement, base64: string): Promise<void> {
    try {
      const res = await fetch(base64);
      const blob = await res.blob();
      const file = new File([blob], "screenshot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      composer.focus();
      composer.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    } catch { /* screenshot paste failed — continue without it */ }
  }

  // -- Helpers --

  function getProviderConfig(): ProviderConfig | null {
    const h = window.location.hostname;
    for (const [d, c] of Object.entries(PROVIDERS)) { if (h.includes(d)) return c; }
    return null;
  }

  function genericSelectors(): string[] {
    return ['[contenteditable="true"]', '[role="textbox"]', "textarea"];
  }

  function findElement(sels: string[]): HTMLElement | null {
    for (const s of sels) {
      try {
        for (const el of document.querySelectorAll(s)) {
          if (isVisible(el as HTMLElement)) return el as HTMLElement;
        }
      } catch { /* skip */ }
    }
    return null;
  }

  function findWithin(container: Element, sels: string[]): HTMLElement | null {
    for (const s of sels) {
      try {
        for (const el of container.querySelectorAll(s)) {
          if (isVisible(el as HTMLElement)) return el as HTMLElement;
        }
      } catch { /* skip */ }
    }
    return null;
  }

  function isVisible(el: HTMLElement): boolean {
    const s = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
  }

  function isDisabled(el: HTMLElement): boolean {
    return el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
  }

  function has(el: HTMLElement, text: string): boolean {
    return (el.innerText || el.textContent || "").includes(text.slice(0, 50));
  }

  function normalize(v: string): string {
    return v.replace(/\u200b/g, "").replace(/\s+\n/g, "\n").replace(/\s+/g, " ").trim();
  }

  function fire(el: HTMLElement, text: string): void {
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  }

  function activate(btn: HTMLElement): void {
    btn.focus();
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, composed: true }));
    }
    btn.click();
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
